"""GET /api/deeplink/{payload} — путь Mini App для deep-link payload'а.

Нужен для запуска по t.me/<bot>/<app>?startapp=<payload> (прямой переход в
Mini App, минуя чат с ботом): payload там приходит не в текстовое сообщение
боту, а в initDataUnsafe.start_param на самом фронте, и путь для навигации
фронт узнаёт отсюда же, откуда его берёт и сам бот для web_app-кнопок
(reply_for_payload) — resolve_payload_path один на обоих потребителей, чтобы
прямой переход и переход через чат бота не могли разъехаться.

Без auth: тот же payload и так открыт всем в кнопках канала, ничего
приватного здесь нет — и фронту он может понадобиться до логина.
"""
from fastapi import APIRouter, HTTPException, status

from app.services.telegram_bot import resolve_payload_path

router = APIRouter(prefix="/deeplink", tags=["deeplink"])


@router.get("/{payload}")
def resolve(payload: str):
    route = resolve_payload_path(payload)
    if route is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown payload")
    return {"route": route}
