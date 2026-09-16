"""Ответы AI на обычные вопросы в личке бота.

До сих пор человек, написавший боту «есть айфон 17 про?», получал меню с
кнопками: консультант существовал, но только внутри Mini App. Канал вёл в
бота, бот — в меню, меню — в приложение. Три шага до вопроса, который можно
задать сразу.

Что здесь есть и чего намеренно нет:

- `build_reply` в telegram_bot НЕ ТРОГАЕТСЯ. Она чистая — ни сети, ни БД, — и
  на этом держатся её тесты. AI туда не воткнуть, поэтому распознавание
  вопроса живёт отдельной чистой функцией, а сам вызов модели — в фоновом
  потоке бота (scripts/bot_polling).
- ответ отправляется НЕ через `send_reply`: та удаляет предыдущее сообщение
  бота, чтобы меню не копилось в чате. Для диалога это разрушительно — вопрос
  и ответ обязаны остаться историей, как остаются уведомления.
- `parse_mode=HTML` включён у всего бота, поэтому любой текст модели сначала
  экранируется и только потом обрастает тегами. Неэкранированный «&» заставит
  Telegram отклонить сообщение ЦЕЛИКОМ, и человек не получит ничего.

Чистые функции тестируются без сети и БД.
"""
from __future__ import annotations

import re
from html import escape

from app.core.config import settings

#: Сколько вопросов к модели разрешено одному чату в окне. Каждый вопрос стоит
#: денег, и без потолка один человек (или один скрипт) выжигает бюджет за
#: вечер. Ограничение живёт В ПАМЯТИ процесса и сбрасывается на каждом деплое —
#: это осознанный размен: БД-счётчик ради демо-магазина не стоит своей цены,
#: а защиту от шквала окно даёт и в таком виде.
AI_QUESTIONS_PER_WINDOW = 10
AI_WINDOW_SECONDS = 60 * 60

#: Короче этого — не вопрос, а «ок», «спасибо», случайный тап. Гонять такое
#: через модель незачем: она ответит вежливой пустотой за наши деньги.
MIN_QUESTION_CHARS = 4

#: Длиннее — почти наверняка вставленный текст, а не вопрос покупателю.
MAX_QUESTION_CHARS = 1000

#: Сколько товаров называем в ответе. В переписке карточек нет, каждый товар
#: это строка и кнопка; больше трёх превращают ответ в простыню.
MAX_PRODUCTS_IN_REPLY = 3


def is_ai_question(update: dict) -> str | None:
    """Текст вопроса, если этот апдейт — обычная реплика человека в личке.

    Возвращает None для всего, на что у бота есть свой ответ: команд, диплинков
    из канала, не-личных чатов, нетекстовых сообщений. Чистая: ни сети, ни БД —
    решение принимается по одному только апдейту.
    """
    message = update.get("message")
    if not isinstance(message, dict):
        return None
    if (message.get("chat") or {}).get("type") != "private":
        return None
    text = message.get("text")
    if not isinstance(text, str):
        return None

    question = text.strip()
    # Команда или диплинк — это разговор с ботом, а не вопрос к магазину.
    if question.startswith("/"):
        return None
    if not (MIN_QUESTION_CHARS <= len(question) <= MAX_QUESTION_CHARS):
        return None
    return question


def allow_question(asked_at: list[float], now: float) -> bool:
    """Влезает ли ещё один вопрос в окно. Чистая: список отметок времени внутрь,
    решение наружу. Вызывающий сам хранит список и сам его чистит."""
    fresh = [t for t in asked_at if now - t < AI_WINDOW_SECONDS]
    return len(fresh) < AI_QUESTIONS_PER_WINDOW


def prune_window(asked_at: list[float], now: float) -> list[float]:
    """Отметки, ещё попадающие в окно."""
    return [t for t in asked_at if now - t < AI_WINDOW_SECONDS]


_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.S)


def to_telegram_html(text: str) -> str:
    """Мини-разметка модели -> HTML Telegram.

    Промпт разрешает модели ровно три вещи: абзацы, `- ` для пунктов и
    `**жирный**` (см. docs/context/ai.md). Здесь они и переводятся.

    ЭКРАНИРОВАНИЕ ИДЁТ ПЕРВЫМ, теги добавляются после — иначе наши же `<b>`
    превратились бы в `&lt;b&gt;`, а текст модели смог бы протащить разметку.
    Текст модели — недоверенный ввод, и HTML из него взяться не должен.
    """
    safe = escape(text or "", quote=False)
    safe = _BOLD_RE.sub(r"<b>\1</b>", safe)
    # Маркер списка: дефис в начале строки -> типографская точка.
    safe = re.sub(r"(?m)^\s*[-•]\s+", "• ", safe)
    return safe.strip()


def _mini_app_url(path: str) -> str | None:
    """Абсолютный https-адрес экрана Mini App, либо None.

    web_app-кнопку Telegram принимает только по https и только абсолютную. Без
    настроенного MINI_APP_URL кнопки просто не будет: отправить её сломанной
    значит получить отказ во ВСЁМ сообщении.
    """
    base = (settings.MINI_APP_URL or "").strip().rstrip("/")
    if not base.startswith("https://"):
        return None
    return f"{base}{path}"


def format_price(value: float) -> str:
    """«104 000 ₽» с неразрывными пробелами: цена не должна рваться переносом."""
    return f"{int(round(value)):,}".replace(",", " ") + " ₽"


def render_answer(answer: dict) -> tuple[str, list[list[dict]]]:
    """Ответ оркестратора -> текст HTML и inline-клавиатура.

    Карточек в переписке нет, поэтому товары называются строками: имя и цена,
    взятые ИЗ КАРТОЧКИ (`to_card`), а не из текста модели — тот же инвариант,
    что и на витрине. У товара без цены (`price_note`, предзаказ) показывается
    его подпись, а не ноль.
    """
    text = to_telegram_html(answer.get("text") or "")
    cards = answer.get("cards") or []
    rows: list[list[dict]] = []

    shown = cards[:MAX_PRODUCTS_IN_REPLY]
    if shown:
        lines = []
        for card in shown:
            title = escape(str(card.get("title_clean") or card.get("title") or ""), quote=False)
            note = card.get("price_note")
            price = escape(str(note), quote=False) if note else format_price(card.get("price") or 0)
            lines.append(f"• <b>{title}</b> — {price}")
        text = f"{text}\n\n" + "\n".join(lines) if text else "\n".join(lines)

        for card in shown:
            url = _mini_app_url(f"/product/{card.get('id')}")
            if not url:
                continue
            label = str(card.get("title_clean") or card.get("title") or "Товар")
            rows.append([{"text": label[:60], "web_app": {"url": url}}])

    continue_url = _mini_app_url("/ai")
    if continue_url:
        rows.append([{"text": "✨ Продолжить в приложении", "web_app": {"url": continue_url}}])

    return text, rows
