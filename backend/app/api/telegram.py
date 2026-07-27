"""Приём апдейтов Telegram-бота (v5.5.0).

Транспорт — вебхук на существующем backend: Caddy уже отдаёт /api/* по HTTPS с
сертификатом Let's Encrypt, поэтому отдельный контейнер бота не нужен, а
рестарт backend автоматически возвращает бота в строй.

Два свойства этого роута важнее всего остального:

1. Он ВСЕГДА отвечает 200. Telegram повторяет доставку апдейта, пока не получит
   успешный ответ, и наращивает задержку. Ответ 500 на упавшем обработчике
   означал бы не «мы починимся позже», а «Telegram будет слать этот же апдейт
   снова» — то есть пользователь получил бы несколько одинаковых ответов, когда
   обработчик заработает. Поэтому любая ошибка логируется и гасится здесь.
2. Наружу не уходит ничего, кроме {"ok": true}. Ни текста исключений, ни
   стек-трейсов — этот эндпоинт публичный.
"""
import logging

from fastapi import APIRouter, Header, HTTPException, Request, status

from app.core.config import settings
from app.services.telegram_bot import build_reply, send_reply

logger = logging.getLogger("techshop.telegram")

router = APIRouter(prefix="/telegram", tags=["telegram"])


@router.post("/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str = Header(default=""),
) -> dict:
    # Секрет не задан => вебхук выключён. Иначе публичный путь принимал бы
    # апдейты от кого угодно.
    if not settings.TELEGRAM_WEBHOOK_SECRET:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if x_telegram_bot_api_secret_token != settings.TELEGRAM_WEBHOOK_SECRET:
        # 403 без подробностей: подделке не сообщаем, что именно не сошлось.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Forbidden")

    try:
        update = await request.json()
    except Exception:  # noqa: BLE001 — битый JSON не повод для ретраев Telegram
        logger.warning("telegram webhook: неразбираемое тело запроса")
        return {"ok": True}

    if not isinstance(update, dict):
        return {"ok": True}

    try:
        reply = build_reply(update)
        if reply is None:
            return {"ok": True}
        chat_id = ((update.get("message") or {}).get("chat") or {}).get("id")
        if chat_id is None:
            return {"ok": True}
        send_reply(chat_id, reply)
    except Exception:  # noqa: BLE001 — см. пункт 1 в докстринге модуля
        logger.exception(
            "telegram webhook: не удалось обработать апдейт %s",
            update.get("update_id"),
        )
    return {"ok": True}
