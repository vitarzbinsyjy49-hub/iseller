"""Service Layer для общения с AI Engine.

Правила интеграции:
- Основной backend знает про AI Engine ТОЛЬКО этот модуль (URL + API key + контракт ответа).
- Внутренняя реализация AI Engine (Ollama, Meilisearch, кэш) здесь не упоминается.
- Любая проблема (недоступен, таймаут, кривой ответ) превращается в AIEngineError —
  роутер по этому исключению включает fallback на обычный поиск по каталогу.
"""
import logging

import httpx

from app.core.config import settings

logger = logging.getLogger("techshop.ai")


class AIEngineError(Exception):
    """AI Engine недоступен или вернул некорректный ответ."""


async def ai_chat(user_id: str, message: str) -> dict:
    """POST /api/v1/chat в AI Engine. Возвращает {text, cards, actions, meta}."""
    if not settings.AI_ENGINE_URL or not settings.AI_ENGINE_API_KEY:
        raise AIEngineError("AI Engine is not configured (AI_ENGINE_URL / AI_ENGINE_API_KEY)")

    url = settings.AI_ENGINE_URL.rstrip("/") + "/api/v1/chat"
    try:
        async with httpx.AsyncClient(timeout=settings.ai_engine_timeout_seconds) as client:
            resp = await client.post(
                url,
                json={"user_id": user_id, "message": message},
                headers={"X-API-Key": settings.AI_ENGINE_API_KEY},
            )
    except httpx.HTTPError as e:  # таймаут, connection refused, DNS и т.д.
        logger.warning("AI Engine unreachable: %s", e)
        raise AIEngineError("AI Engine unreachable") from e

    if resp.status_code != 200:
        logger.warning("AI Engine returned HTTP %s: %s", resp.status_code, resp.text[:300])
        raise AIEngineError(f"AI Engine returned HTTP {resp.status_code}")

    try:
        data = resp.json()
    except ValueError as e:
        raise AIEngineError("AI Engine returned non-JSON response") from e

    # Минимальная валидация контракта (DataContract.md, раздел 2)
    if not isinstance(data, dict) or "text" not in data or "cards" not in data:
        raise AIEngineError("AI Engine response violates data contract")
    return data
