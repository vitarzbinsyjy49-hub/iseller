"""Обработчики команд Telegram-бота (v5.5.0).

Модуль намеренно разделён на две части:

- `build_reply(update)` — ЧИСТАЯ функция: принимает разобранный апдейт Telegram
  и возвращает готовый ответ (текст + клавиатура) либо None, если отвечать не
  нужно. Ни одного сетевого вызова, поэтому всё поведение бота — тексты,
  маршруты кнопок, разбор команд — проверяется обычными тестами без Telegram.
- `send_reply()` — тонкая отправка через Bot API.

Кнопки бывают двух видов и обе НЕ требуют обработки на нашей стороне:
`web_app` открывает Mini App, `url` ведёт наружу (менеджер, канал). Поэтому
callback_query бот не получает и обработчика для них нет — это осознанный
выбор, а не пропуск: любая кнопка, требующая callback, добавила бы состояние
и вторую точку отказа.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import httpx

from app.core.config import settings

TELEGRAM_API = "https://api.telegram.org"

WELCOME = (
    "Добро пожаловать в AI Seller 👋\n"
    "\n"
    "Техника Apple, Dyson и PlayStation по актуальным ценам.\n"
    "\n"
    "Откройте каталог или воспользуйтесь AI-подбором — он поможет выбрать "
    "устройство под ваши задачи и бюджет."
)

FALLBACK_TEXT = "Откройте магазин или воспользуйтесь AI-подбором."

# Список для setMyCommands: в меню Telegram команда идёт без ведущего слэша.
BOT_COMMANDS: list[tuple[str, str]] = [
    ("start", "Главное меню"),
    ("catalog", "Каталог"),
    ("ai", "AI-подбор"),
    ("orders", "Мои заявки"),
    ("manager", "Менеджер"),
    ("prices", "Прайс-листы"),
]

MENU_BUTTON_TEXT = "Открыть магазин"


@dataclass
class Reply:
    text: str
    # inline_keyboard как есть, в формате Bot API: список рядов кнопок.
    keyboard: list[list[dict]] = field(default_factory=list)

    def markup(self) -> dict | None:
        return {"inline_keyboard": self.keyboard} if self.keyboard else None


def _mini_app(path: str) -> str | None:
    """Абсолютный https-URL экрана Mini App.

    web_app-кнопки Telegram принимает только по https и только абсолютные.
    Если MINI_APP_URL не настроен, кнопку показывать нельзя — иначе Telegram
    отклонит ВСЁ сообщение целиком, и пользователь не получит вообще ничего
    вместо одной недостающей кнопки.
    """
    base = (settings.MINI_APP_URL or "").strip().rstrip("/")
    if not base.startswith("https://"):
        return None
    return f"{base}{path}"


def _web_app_button(text: str, path: str) -> dict | None:
    url = _mini_app(path)
    return {"text": text, "web_app": {"url": url}} if url else None


def _url_button(text: str, url: str | None) -> dict | None:
    u = (url or "").strip()
    return {"text": text, "url": u} if u.startswith("https://") else None


def _row(*buttons: dict | None) -> list[dict]:
    """Ряд без «дырок»: кнопки с ненастроенным URL просто исчезают."""
    return [b for b in buttons if b]


def _keyboard(*rows: list[dict]) -> list[list[dict]]:
    return [r for r in rows if r]


def main_keyboard() -> list[list[dict]]:
    """Основная клавиатура главного меню."""
    return _keyboard(
        _row(_web_app_button("🛍 Открыть каталог", "/catalog")),
        _row(
            _web_app_button("✨ Подобрать с AI", "/ai"),
            _web_app_button("📦 Мои заявки", "/requests"),
        ),
        _row(_url_button("💬 Связаться с менеджером", settings.MANAGER_RETAIL_URL)),
        _row(_url_button("📢 Наш канал", settings.TELEGRAM_CHANNEL_URL)),
    )


def parse_command(text: str | None) -> str | None:
    """Имя команды без слэша и без @упоминания бота, или None.

    Telegram дописывает `@botusername` к командам в группах, а некоторые клиенты
    делают это и в личке — `/start@isellerAIbot` обязан работать так же, как
    `/start`. Аргументы после пробела (deep link `/start ref=...`) отбрасываем.
    """
    if not text:
        return None
    head = text.strip().split(maxsplit=1)[0] if text.strip() else ""
    if not head.startswith("/"):
        return None
    name = head[1:].split("@", 1)[0]
    return name.lower() or None


def build_reply(update: dict) -> Reply | None:
    """Ответ на апдейт Telegram, или None если реагировать не нужно.

    Отвечаем только на текстовые сообщения в личном чате. Всё остальное
    (правки сообщений, вступления в чат, посты канала — в том числе наши
    собственные посты в канале магазина) осознанно игнорируем: бот не должен
    комментировать свои же публикации.
    """
    message = update.get("message") or {}
    if not isinstance(message, dict):
        return None
    chat = message.get("chat") or {}
    if chat.get("type") != "private":
        return None
    text = message.get("text")
    if not isinstance(text, str) or not text.strip():
        return None

    command = parse_command(text)

    if command in (None, "start", "menu"):
        if command is None:
            # Обычный текст: подсказка + та же основная клавиатура.
            return Reply(FALLBACK_TEXT, main_keyboard())
        return Reply(WELCOME, main_keyboard())

    if command == "catalog":
        return Reply(
            "Каталог AI Seller — актуальные цены и наличие.",
            _keyboard(_row(_web_app_button("🛍 Открыть каталог", "/catalog"))),
        )
    if command == "ai":
        return Reply(
            "AI-подбор поможет выбрать устройство под ваши задачи и бюджет.",
            _keyboard(_row(_web_app_button("✨ Подобрать с AI", "/ai"))),
        )
    if command == "orders":
        return Reply(
            "Ваши заявки и их статусы.",
            _keyboard(_row(_web_app_button("📦 Мои заявки", "/requests"))),
        )
    if command == "manager":
        return Reply(
            "Менеджер ответит на вопросы по товарам, наличию и доставке.",
            _keyboard(_row(_url_button("💬 Связаться с менеджером", settings.MANAGER_RETAIL_URL))),
        )
    if command == "prices":
        return Reply(
            "Актуальные прайс-листы публикуем в нашем канале — там же обновления "
            "цен и поступления.",
            _keyboard(
                _row(_url_button("📢 Наш канал", settings.TELEGRAM_CHANNEL_URL)),
                _row(_web_app_button("🛍 Открыть каталог", "/catalog")),
            ),
        )

    # Неизвестная команда — тот же ответ, что и на обычный текст: пользователь
    # не должен упереться в молчание, опечатавшись в команде.
    return Reply(FALLBACK_TEXT, main_keyboard())


def send_reply(chat_id: int | str, reply: Reply) -> None:
    """Отправить ответ. Ошибки Telegram логируются вызывающим кодом."""
    if not settings.TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not configured")
    payload: dict = {
        "chat_id": chat_id,
        "text": reply.text,
        "disable_web_page_preview": True,
    }
    markup = reply.markup()
    if markup:
        payload["reply_markup"] = markup
    response = httpx.post(
        f"{TELEGRAM_API}/bot{settings.TELEGRAM_BOT_TOKEN}/sendMessage",
        json=payload,
        timeout=15,
    )
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram rejected sendMessage: {data.get('description')}")
