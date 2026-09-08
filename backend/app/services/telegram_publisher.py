"""Отправка и редактирование сообщений канала.

Прайс-посты живут по принципу «опубликовать один раз, дальше редактировать»,
поэтому здесь есть не только отправка, но и edit_message_* — и обе операции
проходят через один retry-слой: Telegram отвечает 429 с retry_after, и без
уважения к этому заголовку массовое обновление десятка постов упирается в
лимит на середине, оставляя канал в полуобновлённом виде.
"""
import json
import logging
import re
import time
from html import escape

import httpx

from app.core import uploads
from app.core.config import settings
from app.services.telegram_bot import telegram_http_kwargs

logger = logging.getLogger("techshop.telegram")

#: Сколько раз повторяем запрос, упёршийся в лимит или в сетевой сбой.
MAX_ATTEMPTS = 4
#: Потолок ожидания по retry_after: если Telegram просит ждать дольше, честнее
#: вернуть ошибку админу, чем молча держать HTTP-запрос админки минутами.
MAX_RETRY_AFTER = 30


class TelegramPublishError(RuntimeError):
    pass


class TelegramRateLimited(TelegramPublishError):
    """429 с retry_after больше допустимого — операцию нужно повторить позже."""

    def __init__(self, retry_after: int):
        super().__init__(f"Telegram rate limit, повторите через {retry_after} с")
        self.retry_after = retry_after


class TelegramContentTooLong(TelegramPublishError):
    """Собранный текст превышает лимит Telegram (подпись к фото — 1024 симв.,
    обычное сообщение — 4096). Раньше это резалось молча (text[:N]) — админ
    получал успех в ответе и обрезанный текст в канале."""


#: Подпись к фото — Bot API режет caption на этой длине.
MAX_CAPTION_LENGTH = 1024
#: Обычное текстовое сообщение без фото.
MAX_MESSAGE_LENGTH = 4096
#: Лимит символов rich-сообщения (Bot API 10.1) — сильно больше обычных 4096,
#: считает по документации ("Rich Message Limits"), включая alt-текст эмодзи
#: и исходник формул.
MAX_RICH_MESSAGE_LENGTH = 32768


def _sleep(seconds: float) -> None:  # вынесено ради подмены в тестах
    time.sleep(seconds)


def _multipart_data(payload: dict) -> dict:
    """Bot API в multipart/form-data не сериализует поля сам, в отличие от
    json= — вложенные объекты/массивы (reply_markup, rich_message.media)
    нужно превратить в JSON-строку самим, а bool — в "true"/"false" (иначе
    httpx отдаст питоньи "True"/"False", которые Telegram не поймёт)."""
    out = {}
    for key, value in payload.items():
        if isinstance(value, bool):
            out[key] = "true" if value else "false"
        elif isinstance(value, (dict, list)):
            out[key] = json.dumps(value, ensure_ascii=False)
        elif value is not None:
            out[key] = value
    return out


def call(method: str, payload: dict, *, files: dict | None = None) -> dict:
    """Вызов Bot API с повтором при 429 и сетевых сбоях.

    Возвращает поле result. Ошибки Telegram (кроме 429) не повторяем: «chat not
    found» или «message is not modified» от повтора не исправятся.

    files — multipart-вложения (имя поля -> (filename, bytes, content_type)):
    Telegram отказывается сам скачивать медиа с нашего боевого домена
    (*.sslip.io отвечает 200 с верным Content-Type, но Bot API всё равно
    говорит "wrong type of the web page content" — подтверждено вживую), файл
    приходится грузить байтами в теле запроса. Байты, а не открытый файл: при
    ретрае httpx.post вызывается заново тем же kwargs, и файловый объект на
    втором проходе был бы уже дочитан до конца.
    """
    if not settings.TELEGRAM_BOT_TOKEN:
        raise TelegramPublishError("Telegram publishing is not configured")
    url = f"https://api.telegram.org/bot{settings.TELEGRAM_BOT_TOKEN}/{method}"

    last_error = "Telegram is unavailable"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            if files:
                response = httpx.post(
                    url, data=_multipart_data(payload), files=files, timeout=25,
                    **telegram_http_kwargs(),
                )
            else:
                response = httpx.post(url, json=payload, timeout=25, **telegram_http_kwargs())
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            last_error = "Telegram is unavailable"
            logger.warning("%s: сеть недоступна (попытка %s/%s): %s",
                           method, attempt, MAX_ATTEMPTS, exc)
            if attempt < MAX_ATTEMPTS:
                _sleep(2 ** attempt)
                continue
            raise TelegramPublishError(last_error) from exc

        if data.get("ok"):
            return data.get("result")

        description = data.get("description", "Telegram rejected the request")
        if response.status_code == 429:
            retry_after = int((data.get("parameters") or {}).get("retry_after", 1))
            if retry_after > MAX_RETRY_AFTER or attempt == MAX_ATTEMPTS:
                raise TelegramRateLimited(retry_after)
            logger.info("%s: лимит Telegram, жду %s с", method, retry_after)
            _sleep(retry_after)
            continue

        # Логируем метод и причину, но не payload: там текст поста и chat_id.
        logger.warning("%s отклонён Telegram: %s", method, description)
        raise TelegramPublishError(description)

    raise TelegramPublishError(last_error)


def _channel(channel_id: str | int | None = None) -> str | int:
    target = channel_id or settings.TELEGRAM_CHANNEL_ID
    if not target:
        raise TelegramPublishError("Telegram publishing is not configured")
    return target


def send_message(
    *, text: str, keyboard: list[list[dict]] | None = None,
    channel_id: str | int | None = None, disable_notification: bool = False,
) -> int:
    """Опубликовать сообщение с необязательной inline-клавиатурой."""
    payload: dict = {
        "chat_id": _channel(channel_id),
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "disable_notification": disable_notification,
    }
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    return int(call("sendMessage", payload)["message_id"])


#: Расширение файла -> MIME-тип для multipart-загрузки в Telegram. Те же
#: ключи, что app.core.uploads._EXT, но нам нужно направление extension -> type.
_CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
}


def _content_type_for(path) -> str:
    return _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")


def _dispatch_photo(payload: dict, photo: str) -> dict:
    """sendPhoto: наши загрузки уходят multipart-байтами файла, внешние URL —
    полем-ссылкой как раньше (Telegram сам их скачивает — сторонний CDN не
    страдает от бага нашего домена)."""
    local_path = uploads.local_path_for_url(photo)
    if local_path is not None:
        files = {"photo": (local_path.name, local_path.read_bytes(), _content_type_for(local_path))}
        return call("sendPhoto", payload, files=files)
    return call("sendPhoto", {**payload, "photo": photo})


def send_photo(
    *, photo: str, caption: str, keyboard: list[list[dict]] | None = None,
    channel_id: str | int | None = None, disable_notification: bool = False,
) -> int:
    """Опубликовать фото с подписью и необязательной inline-клавиатурой.

    Подпись ограничена MAX_CAPTION_LENGTH (Bot API), не TELEGRAM_TEXT_LIMIT
    обычного сообщения — тот же лимит, что publish_post уже проверяет
    для редакционных постов с фото.
    """
    if len(caption) > MAX_CAPTION_LENGTH:
        raise TelegramContentTooLong(
            f"Подпись к фото ограничена {MAX_CAPTION_LENGTH} символами "
            f"(сейчас {len(caption)}). Сократите текст или уберите изображение."
        )
    payload: dict = {
        "chat_id": _channel(channel_id),
        "caption": caption,
        "parse_mode": "HTML",
        "disable_notification": disable_notification,
    }
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    return int(_dispatch_photo(payload, photo)["message_id"])


#: Bot API принимает в одном альбоме от 2 до 10 медиа.
MEDIA_GROUP_MIN = 2
MEDIA_GROUP_MAX = 10


def send_media_group(
    *, photos: list[str], caption: str = "",
    channel_id: str | int | None = None, disable_notification: bool = False,
) -> list[int]:
    """Альбом фотографий — листается вбок одним сообщением-группой.

    **Клавиатуры у альбома быть не может.** Telegram не принимает
    `reply_markup` у `sendMediaGroup` вовсе — это ограничение Bot API, а не
    наше решение. Поэтому альбом и пост с кнопками — всегда два отдельных
    сообщения: альбом показывает товар, следом идёт текст с кнопками.
    Параметра `keyboard` здесь нет намеренно, чтобы это нельзя было забыть.

    Подпись ставится ТОЛЬКО первому элементу: Telegram показывает её как
    подпись всего альбома. Если поставить её каждому, клиент нарисует один и
    тот же текст под каждой фотографией.

    Возвращает message_id всех сообщений группы — их несколько, по одному на
    фотографию, и это отличает альбом от остальных публикаций здесь.
    """
    if not (MEDIA_GROUP_MIN <= len(photos) <= MEDIA_GROUP_MAX):
        raise TelegramPublishError(
            f"В альбоме должно быть от {MEDIA_GROUP_MIN} до {MEDIA_GROUP_MAX} "
            f"фотографий (сейчас {len(photos)})."
        )
    if len(caption) > MAX_CAPTION_LENGTH:
        raise TelegramContentTooLong(
            f"Подпись к альбому ограничена {MAX_CAPTION_LENGTH} символами "
            f"(сейчас {len(caption)})."
        )

    media: list[dict] = []
    files: dict = {}
    for index, photo in enumerate(photos):
        item: dict = {"type": "photo"}
        if index == 0 and caption:
            item["caption"] = caption
            item["parse_mode"] = "HTML"
        local_path = uploads.local_path_for_url(photo)
        if local_path is None:
            # Внешний URL Telegram скачивает сам — с чужим CDN это работает.
            item["media"] = photo
        else:
            # Своя загрузка уходит байтами: с нашего домена Telegram медиа не
            # забирает (см. docs/context/channel-posts.md). Имя поля должно
            # совпадать с ключом в files — так медиа связывается с файлом.
            key = f"photo{index}"
            item["media"] = f"attach://{key}"
            files[key] = (local_path.name, local_path.read_bytes(),
                          _content_type_for(local_path))
        media.append(item)

    payload = {
        "chat_id": _channel(channel_id),
        "media": media,
        "disable_notification": disable_notification,
    }
    result = call("sendMediaGroup", payload, files=files or None)
    return [int(m["message_id"]) for m in (result or [])]


def edit_message(
    *, message_id: int, text: str, keyboard: list[list[dict]] | None = None,
    channel_id: str | int | None = None,
) -> bool:
    """Переписать текст ранее опубликованного сообщения.

    «message is not modified» — не ошибка, а нормальный ответ на повторное
    обновление без изменений: возвращаем False, чтобы вызывающий код мог
    отличить «нечего менять» от настоящего сбоя.
    """
    payload: dict = {
        "chat_id": _channel(channel_id),
        "message_id": message_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    try:
        call("editMessageText", payload)
        return True
    except TelegramRateLimited:
        raise
    except TelegramPublishError as exc:
        if "not modified" in str(exc).lower():
            return False
        raise


def edit_caption(
    *, message_id: int, caption: str, keyboard: list[list[dict]] | None = None,
    channel_id: str | int | None = None,
) -> bool:
    """Переписать подпись фото (и, при передаче, клавиатуру) ранее
    опубликованного сообщения.

    Отдельная ручка Bot API от editMessageText: сообщение с фото хранит текст
    в caption, а editMessageText на нём отвечает «there is no text in the
    message to edit». editMessageCaption принимает reply_markup тем же
    вызовом — отдельный editMessageReplyMarkup для этого случая не нужен.
    """
    payload: dict = {
        "chat_id": _channel(channel_id),
        "message_id": message_id,
        "caption": caption,
        "parse_mode": "HTML",
    }
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    try:
        call("editMessageCaption", payload)
        return True
    except TelegramRateLimited:
        raise
    except TelegramPublishError as exc:
        if "not modified" in str(exc).lower():
            return False
        raise


def edit_reply_markup(
    *, message_id: int, keyboard: list[list[dict]],
    channel_id: str | int | None = None,
) -> bool:
    """Обновить только клавиатуру — так навигационный пост меняется без перепубликации."""
    payload = {
        "chat_id": _channel(channel_id),
        "message_id": message_id,
        "reply_markup": {"inline_keyboard": keyboard},
    }
    try:
        call("editMessageReplyMarkup", payload)
        return True
    except TelegramRateLimited:
        raise
    except TelegramPublishError as exc:
        if "not modified" in str(exc).lower():
            return False
        raise


def _build_rich_message(html: str) -> tuple[dict, dict]:
    """Готовит поле rich_message и multipart-вложения (если есть) под него."""
    html, media, files = _prepare_rich_media(html)
    if len(html) > MAX_RICH_MESSAGE_LENGTH:
        raise TelegramContentTooLong(
            f"Rich-сообщение ограничено {MAX_RICH_MESSAGE_LENGTH} символами "
            f"(сейчас {len(html)})."
        )
    rich_message: dict = {"html": html}
    if media:
        rich_message["media"] = media
    return rich_message, files


def send_rich_message(
    *, html: str, keyboard: list[list[dict]] | None = None,
    channel_id: str | int | None = None, disable_notification: bool = False,
) -> int:
    """Опубликовать rich-сообщение (Bot API 10.1 sendRichMessage): настоящие
    таблицы, заголовки, сворачиваемые <details> — не имитация моноширинным
    текстом. html идёт в rich_message.html — тот же "Rich HTML style", что
    Telegram поддерживает для parse_mode=HTML, плюс table/details/heading/hr.
    """
    rich_message, files = _build_rich_message(html)
    payload: dict = {
        "chat_id": _channel(channel_id),
        "rich_message": rich_message,
        "disable_notification": disable_notification,
    }
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    result = call("sendRichMessage", payload, files=files or None)
    return int(result["message_id"])


def edit_rich_message(
    *, message_id: int, html: str, keyboard: list[list[dict]] | None = None,
    channel_id: str | int | None = None,
) -> bool:
    """Переписать rich-содержимое ранее опубликованного сообщения.

    editMessageText — единая ручка Bot API и для обычного текста, и для rich
    ("edit text, rich and game messages" в документации): поле rich_message
    заменяет text тем же вызовом, отдельного editRichMessageText не существует.
    """
    rich_message, files = _build_rich_message(html)
    payload: dict = {
        "chat_id": _channel(channel_id),
        "message_id": message_id,
        "rich_message": rich_message,
    }
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    try:
        call("editMessageText", payload, files=files or None)
        return True
    except TelegramRateLimited:
        raise
    except TelegramPublishError as exc:
        if "not modified" in str(exc).lower():
            return False
        raise


def pin_message(*, message_id: int, channel_id: str | int | None = None) -> None:
    call("pinChatMessage", {
        "chat_id": _channel(channel_id),
        "message_id": message_id,
        "disable_notification": True,
    })


def public_image_url(image_url: str | None) -> str | None:
    """Абсолютная ссылка на картинку — Telegram скачивает фото по URL сам.

    Наши загрузки хранятся как относительный путь (/api/uploads/...);
    префиксуем публичным доменом Mini App. Уже абсолютные ссылки (внешние
    URL) не трогаем.
    """
    if image_url and image_url.startswith("/"):
        public_base = settings.MINI_APP_URL.rstrip("/")
        return f"{public_base}{image_url}" if public_base else None
    return image_url


#: rich_html пишет админ вручную — src в <img>/<video>/<audio> легко получится
#: относительным (/api/uploads/...), как и у обычных постов. Группа 2 — имя
#: тега, нужно отдельно от всего префикса, чтобы выбрать тип медиа.
_RICH_MEDIA_SRC_RE = re.compile(r'(<(img|video|audio)\b[^>]*\bsrc=")([^"]*)(")', re.IGNORECASE)

#: тег -> тип медиа в терминах InputMediaPhoto/Video/Audio (Bot API).
_RICH_MEDIA_TYPE_BY_TAG = {"img": "photo", "video": "video", "audio": "audio"}


def _prepare_rich_media(html: str) -> tuple[str, list[dict], dict]:
    """Готовит медиа rich-контента к отправке.

    Telegram сам скачивает медиа по URL из rich_message.html — и принципиально
    отказывается делать это с нашего боевого домена (*.sslip.io): 200 OK с
    верным Content-Type, но "wrong type of the web page content", подтверждено
    вживую 19.08.2026. Поэтому свои загрузки (те, что реально есть на диске)
    уходят как multipart-вложения и адресуются через InputRichMessage.media +
    tg://photo|video|audio?id=... (Bot API 10.2, добавлено 14.07.2026) —
    единственный способ вставить в rich-контент медиа не по HTTP(S)-URL.
    Внешние ссылки (чужой CDN) не трогаем — тот случай Telegram и раньше
    скачивал сам без проблем.
    """
    media: list[dict] = []
    files: dict[str, tuple[str, bytes, str]] = {}
    counter = 0

    def repl(match: re.Match) -> str:
        nonlocal counter
        prefix, tag, src, suffix = match.group(1), match.group(2), match.group(3), match.group(4)
        local_path = uploads.local_path_for_url(src)
        if local_path is not None:
            counter += 1
            media_id = f"m{counter}"
            attach_name = f"{media_id}_{local_path.name}"
            media_type = _RICH_MEDIA_TYPE_BY_TAG[tag.lower()]
            media.append({
                "id": media_id,
                "media": {"type": media_type, "media": f"attach://{attach_name}"},
            })
            files[attach_name] = (
                local_path.name, local_path.read_bytes(), _content_type_for(local_path),
            )
            return f"{prefix}tg://{media_type}?id={media_id}{suffix}"

        if not src.startswith("/"):
            return match.group(0)
        absolute = public_image_url(src)
        if not absolute:
            raise TelegramPublishError(
                f"Rich-контент ссылается на относительный путь {src!r}, а "
                "MINI_APP_URL не настроен — Telegram не сможет скачать медиа."
            )
        return f"{prefix}{absolute}{suffix}"

    new_html = _RICH_MEDIA_SRC_RE.sub(repl, html)
    return new_html, media, files


def publish_post(*, title: str, body: str, image_url: str | None) -> int:
    """Опубликовать одобренный новостной пост и вернуть message_id.

    Существующий путь модерации постов — не трогаем его поведение, только
    переводим на общий retry-слой (429, сетевые сбои).
    """
    if not settings.TELEGRAM_CHANNEL_ID:
        raise TelegramPublishError("Telegram publishing is not configured")

    text = f"<b>{escape(title)}</b>\n\n{escape(body)}".strip()
    image_url = public_image_url(image_url)

    if image_url:
        if len(text) > MAX_CAPTION_LENGTH:
            raise TelegramContentTooLong(
                f"Текст с фото ограничен {MAX_CAPTION_LENGTH} символами "
                f"(сейчас {len(text)}). Сократите текст или уберите изображение."
            )
        result = _dispatch_photo({
            "chat_id": settings.TELEGRAM_CHANNEL_ID,
            "caption": text,
            "parse_mode": "HTML",
        }, image_url)
    else:
        if len(text) > MAX_MESSAGE_LENGTH:
            raise TelegramContentTooLong(
                f"Текст ограничен {MAX_MESSAGE_LENGTH} символами (сейчас {len(text)})."
            )
        result = call("sendMessage", {
            "chat_id": settings.TELEGRAM_CHANNEL_ID,
            "text": text,
            "parse_mode": "HTML",
        })
    return int(result["message_id"])


def delete_message(*, message_id: int, channel_id: str | int | None = None) -> bool:
    """Удалить сообщение канала.

    Операция необратима, поэтому в обычном потоке публикации её нет: система
    умеет создавать и править, но не удалять. Функция нужна для разовых
    перестроек структуры разделов, когда несколько постов схлопываются в один и
    лишние сообщения обязаны исчезнуть, а не остаться висеть без навигации.

    «message to delete not found» — не ошибка: сообщение уже удалено, цель
    достигнута.
    """
    try:
        call("deleteMessage", {"chat_id": _channel(channel_id), "message_id": message_id})
        return True
    except TelegramPublishError as exc:
        if "not found" in str(exc).lower():
            return False
        raise
