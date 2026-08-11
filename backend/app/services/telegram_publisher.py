"""Отправка и редактирование сообщений канала.

Прайс-посты живут по принципу «опубликовать один раз, дальше редактировать»,
поэтому здесь есть не только отправка, но и edit_message_* — и обе операции
проходят через один retry-слой: Telegram отвечает 429 с retry_after, и без
уважения к этому заголовку массовое обновление десятка постов упирается в
лимит на середине, оставляя канал в полуобновлённом виде.
"""
import logging
import time
from html import escape

import httpx

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


def _sleep(seconds: float) -> None:  # вынесено ради подмены в тестах
    time.sleep(seconds)


def call(method: str, payload: dict) -> dict:
    """Вызов Bot API с повтором при 429 и сетевых сбоях.

    Возвращает поле result. Ошибки Telegram (кроме 429) не повторяем: «chat not
    found» или «message is not modified» от повтора не исправятся.
    """
    if not settings.TELEGRAM_BOT_TOKEN:
        raise TelegramPublishError("Telegram publishing is not configured")
    url = f"https://api.telegram.org/bot{settings.TELEGRAM_BOT_TOKEN}/{method}"

    last_error = "Telegram is unavailable"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
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


def pin_message(*, message_id: int, channel_id: str | int | None = None) -> None:
    call("pinChatMessage", {
        "chat_id": _channel(channel_id),
        "message_id": message_id,
        "disable_notification": True,
    })


def publish_post(*, title: str, body: str, image_url: str | None) -> int:
    """Опубликовать одобренный новостной пост и вернуть message_id.

    Существующий путь модерации постов — не трогаем его поведение, только
    переводим на общий retry-слой (429, сетевые сбои).
    """
    if not settings.TELEGRAM_CHANNEL_ID:
        raise TelegramPublishError("Telegram publishing is not configured")

    text = f"<b>{escape(title)}</b>\n\n{escape(body)}".strip()
    # Telegram скачивает фото по URL сам, поэтому ссылка обязана быть абсолютной.
    # Наши загрузки (/api/uploads/...) префиксуем публичным доменом Mini App.
    if image_url and image_url.startswith("/"):
        public_base = settings.MINI_APP_URL.rstrip("/")
        image_url = f"{public_base}{image_url}" if public_base else None

    if image_url:
        if len(text) > MAX_CAPTION_LENGTH:
            raise TelegramContentTooLong(
                f"Текст с фото ограничен {MAX_CAPTION_LENGTH} символами "
                f"(сейчас {len(text)}). Сократите текст или уберите изображение."
            )
        result = call("sendPhoto", {
            "chat_id": settings.TELEGRAM_CHANNEL_ID,
            "photo": image_url,
            "caption": text,
            "parse_mode": "HTML",
        })
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
