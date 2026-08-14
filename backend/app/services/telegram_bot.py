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
from html import escape

import httpx

from app.core.config import settings

TELEGRAM_API = "https://api.telegram.org"


def telegram_http_kwargs() -> dict:
    """Аргументы httpx для обращений к Telegram: прокси, если он настроен.

    Единая точка на весь проект, чтобы ответы бота и публикация постов в канал
    не разъехались: если Telegram доступен только через прокси, это верно для
    ВСЕХ исходящих обращений к нему, а не для какого-то одного места.
    """
    proxy = (settings.TELEGRAM_PROXY_URL or "").strip()
    return {"proxy": proxy} if proxy else {}


WELCOME = (
    "Добро пожаловать в AI Seller 👋\n"
    "\n"
    "Техника Apple, Dyson и PlayStation по актуальным ценам.\n"
    "\n"
    "Откройте каталог или воспользуйтесь AI-подбором — он поможет выбрать "
    "устройство под ваши задачи и бюджет.\n"
    "\n"
    "ℹ️ AI Seller — информационный ИИ-каталог, не интернет-магазин. Бот и "
    "приложение помогают подобрать технику и оформить заявку; сама сделка "
    "— оплата и передача товара — проходит очно, наличными, при получении."
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


def parse_start_payload(text: str | None) -> str | None:
    """Аргумент deep link: «/start price_iphone» -> «price_iphone».

    Кнопки в канале не могут быть web_app (Telegram отвергает такое сообщение
    целиком), поэтому они ведут на t.me/<bot>?start=<раздел>. Пользователь
    попадает в чат с ботом, и вот здесь мы обязаны открыть именно тот раздел,
    ради которого он нажал кнопку, — иначе кнопка «Открыть раздел» превратится
    в обычное «Открыть магазин».
    """
    if not text:
        return None
    parts = text.strip().split(maxsplit=1)
    if len(parts) < 2 or not parts[0].startswith("/start"):
        return None
    payload = parts[1].strip()
    return payload if payload else None


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


def parse_product_payload(payload: str) -> int | None:
    """«product_42» -> 42. Всё остальное -> None.

    Строгая проверка на цифры обязательна: payload приходит из ссылки, которую
    мог собрать кто угодно, а результат подставляется в URL кнопки. `isdigit`
    здесь мало — он пропускает юникод-цифры вроде «٤٢», поэтому проверяем по
    ASCII и заодно отсекаем неправдоподобно длинные значения.
    """
    prefix = "product_"
    if not payload.startswith(prefix):
        return None
    raw = payload[len(prefix):]
    if not raw or len(raw) > 12 or not all(c in "0123456789" for c in raw):
        return None
    value = int(raw)
    return value if value > 0 else None


def reply_for_payload(payload: str) -> Reply | None:
    """Ответ на deep link: раздел прайса, каталог, AI-подбор или товар.

    Здесь web_app-кнопки уже законны — это личный чат с ботом, а не канал.
    """
    from app.services.price_posts import SECTIONS_BY_SLUG   # локально: избегаем цикла

    if payload == "catalog":
        return build_reply({"message": {"chat": {"type": "private"}, "text": "/catalog"}})
    if payload == "ai":
        return build_reply({"message": {"chat": {"type": "private"}, "text": "/ai"}})
    # Кнопка "Мои заявки" (kind=requests) в конструкторе инфо-постов админки
    # собирает именно такой payload — без этой ветки он не резолвился и молча
    # падал в общее меню вместо фокусированного экрана заявок.
    if payload == "requests":
        return build_reply({"message": {"chat": {"type": "private"}, "text": "/orders"}})

    # Товар, которым поделились. НАЗВАНИЕ ТОВАРА ЗДЕСЬ НЕ ЧИТАЕТСЯ ИЗ БАЗЫ
    # намеренно: build_reply и reply_for_payload не ходят в БД и не ходят в
    # сеть, поэтому всё поведение бота проверяется обычными тестами. Название
    # человек и так видит в сообщении, по которому пришёл; наша задача —
    # довести его до карточки одним нажатием.
    product_id = parse_product_payload(payload)
    if product_id is not None:
        button = _web_app_button("🛍 Открыть товар", f"/product/{product_id}")
        if button is None:
            # Mini App не настроен — кнопки не будет; отправлять сообщение с
            # обещанием и без кнопки хуже, чем общее меню.
            return Reply(WELCOME, main_keyboard())
        return Reply(
            "Вот товар, которым с вами поделились.",
            _keyboard(
                _row(button),
                _row(
                    _web_app_button("🛍 Весь каталог", "/catalog"),
                    _url_button("💬 Менеджер", settings.MANAGER_RETAIL_URL),
                ),
            ),
        )

    section = SECTIONS_BY_SLUG.get(payload)
    if section is None:
        return None
    button = _web_app_button(f"🛍 Открыть раздел «{section.title}»", section.route)
    return Reply(
        # escape: текст уходит с parse_mode=HTML, и «&» в названии раздела
        # заставил бы Telegram отклонить сообщение целиком. Названия сейчас —
        # константы кода, но это единственное, что их защищает.
        f"{section.emoji} <b>{escape(section.title)}</b>\n"
        "\nОткройте раздел в каталоге — там актуальные цены, фото и наличие.",
        _keyboard(
            _row(button),
            _row(
                _web_app_button("✨ Подобрать с AI", "/ai"),
                _url_button("💬 Менеджер", settings.MANAGER_RETAIL_URL),
            ),
        ),
    )


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

    # Переход по кнопке из канала: открываем ровно тот раздел, который нажали.
    payload = parse_start_payload(text)
    if command == "start" and payload:
        reply = reply_for_payload(payload)
        if reply is not None:
            return reply

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


#: message_id последнего ответа бота в чате — чтобы следующий ответ удалил
#: его, а не копился рядом. В памяти процесса и не переживает рестарт: это ok,
#: максимум одно старое сообщение не удалится до следующего ответа бота.
_last_bot_message: dict[int | str, int] = {}


def _delete_message(chat_id: int | str, message_id: int) -> None:
    """Удалить сообщение в чате. Best-effort: оно могло быть уже удалено
    вручную или устареть для Telegram — это не повод ронять обработку
    текущего апдейта, поэтому ошибки publisher'а здесь глотаются."""
    from app.services.telegram_publisher import TelegramPublishError, call

    try:
        call("deleteMessage", {"chat_id": chat_id, "message_id": message_id})
    except TelegramPublishError:
        pass


def send_reply(chat_id: int | str, reply: Reply, *, incoming_message_id: int | None = None) -> None:
    """Отправить ответ. Ошибки Telegram логируются вызывающим кодом.

    `parse_mode=HTML` обязателен: тексты ответов содержат разметку (`<b>` в
    ответе на кнопку раздела из канала). Без него Telegram показывает теги
    БУКВАЛЬНО — человек, пришедший по кнопке из канала, видел «📱 <b>iPhone</b>»
    вместе с угловыми скобками. Это был самый заметный путь входа в магазин.

    Раз режим HTML включён, любая подстановка в текст обязана экранироваться
    (см. `escape` в reply_for_payload): неэкранированный «&» в тексте заставит
    Telegram отклонить сообщение ЦЕЛИКОМ, и человек не получит ничего.

    Чат держится чистым: перед отправкой удаляется предыдущий ответ бота в
    этом чате (см. `_last_bot_message`) — иначе команды пользователя копят в
    чате одинаковые сообщения. `incoming_message_id` — id сообщения самого
    пользователя (`/start`, `/catalog`...), которое вызвало этот ответ; оно
    удаляется тоже, вызывающий код передаёт его из апдейта Telegram.
    Уведомления (`services/notifications.py` — падение цены, неоплаченная
    корзина) и посты канала идут другими функциями, этот путь их не касается —
    их история остаётся навсегда.
    """
    if not settings.TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not configured")

    previous_message_id = _last_bot_message.pop(chat_id, None)
    if previous_message_id is not None:
        _delete_message(chat_id, previous_message_id)
    if incoming_message_id is not None:
        _delete_message(chat_id, incoming_message_id)

    payload: dict = {
        "chat_id": chat_id,
        "text": reply.text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    markup = reply.markup()
    if markup:
        payload["reply_markup"] = markup

    # Отправляем через общий retry-слой publisher'а (429 + сетевые сбои), а не
    # одиночным httpx.post. Причина конкретная: исходящие в Telegram идут через
    # WARP-прокси, и обрыв там — обычное дело, а не исключительная ситуация. При
    # единственной попытке такой обрыв означал, что человек написал боту и НЕ
    # ПОЛУЧИЛ НИЧЕГО, причём молча: ретраить некому, входящий апдейт уже
    # подтверждён сдвинутым offset'ом.
    #
    # Импорт локальный: publisher сам импортирует этот модуль (telegram_http_kwargs),
    # и на уровне модуля вышел бы цикл. Тот же приём, что в reply_for_payload.
    from app.services.telegram_publisher import call

    result = call("sendMessage", payload)

    if isinstance(result, dict):
        message_id = result.get("message_id")
        if message_id is not None:
            _last_bot_message[chat_id] = int(message_id)
