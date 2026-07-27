from html import escape

import httpx

from app.core.config import settings
from app.services.telegram_bot import telegram_http_kwargs


class TelegramPublishError(RuntimeError):
    pass


def publish_post(*, title: str, body: str, image_url: str | None) -> int:
    """Publish one approved post and return Telegram's message id."""
    if not settings.TELEGRAM_BOT_TOKEN or not settings.TELEGRAM_CHANNEL_ID:
        raise TelegramPublishError("Telegram publishing is not configured")

    text = f"<b>{escape(title)}</b>\n\n{escape(body)}".strip()
    base = f"https://api.telegram.org/bot{settings.TELEGRAM_BOT_TOKEN}"
    # Telegram скачивает фото по URL сам, поэтому ссылка обязана быть абсолютной.
    # Наши загрузки (/api/uploads/...) префиксуем публичным доменом Mini App.
    if image_url and image_url.startswith("/"):
        public_base = settings.MINI_APP_URL.rstrip("/")
        image_url = f"{public_base}{image_url}" if public_base else None
    if image_url:
        method = "sendPhoto"
        payload = {
            "chat_id": settings.TELEGRAM_CHANNEL_ID,
            "photo": image_url,
            "caption": text[:1024],
            "parse_mode": "HTML",
        }
    else:
        method = "sendMessage"
        payload = {"chat_id": settings.TELEGRAM_CHANNEL_ID, "text": text[:4096], "parse_mode": "HTML"}

    try:
        response = httpx.post(f"{base}/{method}", json=payload, timeout=20,
                              **telegram_http_kwargs())
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise TelegramPublishError("Telegram is unavailable") from exc
    if not response.is_success or not data.get("ok"):
        raise TelegramPublishError(data.get("description", "Telegram rejected the post"))
    return int(data["result"]["message_id"])
