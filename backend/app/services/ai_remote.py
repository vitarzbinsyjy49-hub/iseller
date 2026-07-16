"""Клиент AI Gateway (Mac mini + Ollama), v5.

Backend знает про Gateway только этот модуль: URL, API key, контракт.
Любая проблема (сеть, таймаут, не-200, кривой ответ) -> AIGatewayError,
по которому оркестратор уходит в детерминированный fallback.
"""
import logging

import httpx

from app.core.config import settings

logger = logging.getLogger("techshop.ai.gateway")


class AIGatewayError(Exception):
    """AI Gateway недоступен или ответил вне контракта."""


async def call_gateway(*, system: str, message: str, history: list[dict], candidates: list[dict]) -> dict:
    """POST /v1/chat на Gateway. Возвращает {content, model, total_ms, ...}.

    content — сырой текст модели (ожидается JSON, парсится в ai_schemas).
    """
    if not settings.AI_GATEWAY_URL or not settings.AI_GATEWAY_API_KEY:
        raise AIGatewayError("AI Gateway is not configured (AI_GATEWAY_URL / AI_GATEWAY_API_KEY)")

    url = settings.AI_GATEWAY_URL.rstrip("/") + "/v1/chat"
    payload = {
        "system": system,
        "message": message,
        "history": history,
        "candidates": candidates,
    }
    try:
        async with httpx.AsyncClient(timeout=settings.AI_TIMEOUT_SECONDS or 45.0) as client:
            resp = await client.post(url, json=payload, headers={"X-API-Key": settings.AI_GATEWAY_API_KEY})
    except httpx.HTTPError as e:  # таймаут/refused/DNS — без деталей наружу
        logger.warning("AI Gateway unreachable: %s", type(e).__name__)
        raise AIGatewayError("AI Gateway unreachable") from e

    if resp.status_code != 200:
        logger.warning("AI Gateway HTTP %s: %s", resp.status_code, resp.text[:200])
        raise AIGatewayError(f"AI Gateway returned HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as e:
        raise AIGatewayError("AI Gateway returned non-JSON") from e
    if not isinstance(data, dict) or not isinstance(data.get("content"), str) or not data["content"].strip():
        raise AIGatewayError("AI Gateway response violates contract")
    return data
