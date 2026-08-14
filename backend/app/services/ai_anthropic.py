"""Клиент Anthropic Messages API для AI-консультанта (v5.7).

Backend знает про Anthropic только этот модуль: ключ, модель, контракт.
Возврат совпадает с `call_gateway()` (см. ai_remote.py) — {content, model,
total_ms} — поэтому оркестратор не знает, кто именно отвечал, и все его
защитные слои (лимит кандидатов, валидация id, вычистка денежных
утверждений, деградация в fallback) работают без изменений.

Любая проблема — сеть, регион, лимит, отказ модели, обрезанный ответ —
превращается в AIGatewayError, по которому оркестратор уходит в
детерминированный fallback. Пользователь никогда не видит ни JSON, ни
traceback, ни имя модели.

Модель по умолчанию — Haiku: самая дешёвая и быстрая, чего для консультанта
по каталогу достаточно (весь подбор товаров уже сделал backend, модель лишь
объясняет выбор). `effort` и adaptive thinking на Haiku 4.5 не поддерживаются
и здесь не передаются.
"""
import json
import logging
import time
from functools import lru_cache

import anthropic
import httpx
from anthropic import AsyncAnthropic

from app.core.config import settings
from app.services.ai_remote import AIGatewayError  # общий тип ошибки для обоих транспортов
from app.services.ai_schemas import INTENTS, NEXT_ACTIONS

logger = logging.getLogger("techshop.ai.anthropic")

_STR_LIST = {"type": "array", "items": {"type": "string"}}


def _nullable(kind: str) -> dict:
    # anyOf вместо ["string","null"]: structured outputs гарантированно понимают anyOf
    return {"anyOf": [{"type": kind}, {"type": "null"}]}


# Схема structured output. Собрана из тех же INTENTS/NEXT_ACTIONS, что валидирует
# ai_schemas — enum в схеме и валидатор не могут разъехаться.
# Ограничения structured outputs: additionalProperties=false обязателен у каждого
# объекта, min/max-констрейнты не поддерживаются (длину answer режет pydantic).
ANSWER_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "intent", "answer", "follow_up_question", "recommended_product_ids",
        "comparison", "filters", "quick_replies", "next_action", "confidence",
    ],
    "properties": {
        "intent": {"type": "string", "enum": sorted(INTENTS)},
        "answer": {"type": "string"},
        "follow_up_question": _nullable("string"),
        "recommended_product_ids": {"type": "array", "items": {"type": "integer"}},
        "comparison": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["product_id", "best_for", "strengths", "tradeoffs"],
                "properties": {
                    "product_id": {"type": "integer"},
                    "best_for": {"type": "string"},
                    "strengths": _STR_LIST,
                    "tradeoffs": _STR_LIST,
                },
            },
        },
        "filters": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "category", "brands", "budget_min", "budget_max",
                "use_cases", "required_features", "excluded_features",
            ],
            "properties": {
                "category": _nullable("string"),
                "brands": _STR_LIST,
                "budget_min": _nullable("number"),
                "budget_max": _nullable("number"),
                "use_cases": _STR_LIST,
                "required_features": _STR_LIST,
                "excluded_features": _STR_LIST,
            },
        },
        "quick_replies": {"type": "array", "items": {"type": "string"}},
        "next_action": {"type": "string", "enum": sorted(NEXT_ACTIONS)},
        "confidence": {"type": "number"},
    },
}


def build_user_message(*, message: str, context: str, candidates: list[dict]) -> str:
    """Единственное user-сообщение: недоверенная история -> данные -> вопрос.

    Чистая функция без сети — так её можно проверять тестами (тот же приём, что
    у build_reply в telegram_bot). История клиента НЕ отправляется отдельными
    assistant-сообщениями: клиент может подделать роль и вписать «системные
    указания», поэтому она идёт помеченным блоком данных внутри user-сообщения.
    """
    parts: list[str] = []
    if context:
        parts.append(context)
    parts.append(
        "AVAILABLE_PRODUCTS (единственный источник правды о товарах, JSON):\n"
        + json.dumps(candidates, ensure_ascii=False)
    )
    parts.append("Вопрос покупателя:\n" + message)
    return "\n\n".join(parts)


def _proxy_url() -> str | None:
    """Прокси до гейтвея, если он настроен. Отдельная функция — ради теста."""
    return (settings.AI_GATEWAY_PROXY_URL or "").strip() or None


def _proxied_http_client() -> httpx.AsyncClient | None:
    """httpx-клиент через прокси, или None — тогда SDK создаёт свой, прямой.

    Вынесено из `_client` отдельно, чтобы проверяться тестом напрямую: подмена
    самого `httpx.AsyncClient` ломает isinstance-проверку внутри SDK, то есть
    тест начинал бы падать на чужой реализации, а не на нашей ошибке.
    """
    proxy = _proxy_url()
    if not proxy:
        return None
    return httpx.AsyncClient(proxy=proxy, timeout=settings.AI_ANTHROPIC_TIMEOUT_SECONDS)


@lru_cache(maxsize=1)
def _client() -> AsyncAnthropic:
    """Клиент переиспользуется процессом ради пула соединений.
    Настройки читаются один раз; в тестах сбрасывать через _client.cache_clear()."""
    kwargs: dict = {
        "api_key": settings.AI_ANTHROPIC_API_KEY,
        "timeout": settings.AI_ANTHROPIC_TIMEOUT_SECONDS,
        "max_retries": 2,  # SDK сам ретраит 429/5xx/сетевые с экспоненциальной паузой
    }
    # Пусто => api.anthropic.com. На проде — прокси в открытом регионе: прямой
    # доступ оттуда отдаёт 403 ещё до проверки ключа. SDK сам допишет
    # /v1/messages, поэтому base_url задаётся без этого хвоста.
    if settings.AI_ANTHROPIC_BASE_URL:
        kwargs["base_url"] = settings.AI_ANTHROPIC_BASE_URL
    # Тот же WARP, что уносит Telegram: домен гейтвея резолвится в несколько
    # адресов Vercel, и до части из них сеть VPS не доходит — соединение виснет
    # на TCP-таймауте, а не отвечает отказом, поэтому лечится это маршрутом, а
    # не ретраями. Клиент передаём свой: SDK иначе создаёт httpx без прокси.
    http_client = _proxied_http_client()
    if http_client is not None:
        kwargs["http_client"] = http_client
    return AsyncAnthropic(**kwargs)


async def call_anthropic(*, system: str, message: str, context: str, candidates: list[dict]) -> dict:
    """Один запрос в Messages API. Возвращает {content, model, total_ms}.

    content — сырой текст модели (ожидается JSON, парсится в ai_schemas).
    """
    if not settings.AI_ANTHROPIC_API_KEY:
        raise AIGatewayError("Anthropic is not configured (AI_ANTHROPIC_API_KEY)")

    user_content = build_user_message(message=message, context=context, candidates=candidates)

    async def _create(with_schema: bool):
        kwargs: dict = {
            "model": settings.AI_ANTHROPIC_MODEL,
            "max_tokens": settings.AI_ANTHROPIC_MAX_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": user_content}],
        }
        if with_schema:
            # Structured outputs: ответ гарантированно валидный JSON по схеме,
            # а не «JSON, обёрнутый в пояснения» — для маленькой модели это
            # заметно надёжнее, чем просить формат словами в промпте.
            kwargs["output_config"] = {
                "format": {"type": "json_schema", "schema": ANSWER_SCHEMA},
            }
        return await _client().messages.create(**kwargs)

    t0 = time.monotonic()
    try:
        try:
            resp = await _create(True)
        except anthropic.BadRequestError:
            # Схему не приняли (не тот тариф/модель/версия API). Повторяем один
            # раз без неё: системный промпт и так требует строгий JSON, а парсер
            # умеет repair. Ухудшить качество разбора лучше, чем молча уходить в
            # fallback на каждом запросе — это самый дорогой вид отказа.
            logger.warning("Anthropic rejected output schema, retrying without it")
            resp = await _create(False)
    except anthropic.RateLimitError as e:
        logger.warning("Anthropic rate limited")
        raise AIGatewayError("Anthropic rate limited") from e
    except anthropic.APIStatusError as e:
        # Тело ответа не логируем целиком: там может быть эхо пользовательского ввода.
        logger.warning("Anthropic HTTP %s", e.status_code)
        raise AIGatewayError(f"Anthropic returned HTTP {e.status_code}") from e
    except anthropic.APIConnectionError as e:  # таймаут/DNS/отказ — без деталей наружу
        logger.warning("Anthropic unreachable: %s", type(e).__name__)
        raise AIGatewayError("Anthropic unreachable") from e

    # Отказ классификатора и обрыв по лимиту токенов: в обоих случаях полезного
    # JSON нет. Честно деградируем в fallback вместо пустого/битого ответа.
    if resp.stop_reason == "refusal":
        logger.warning("Anthropic refused the request")
        raise AIGatewayError("Anthropic refused the request")
    if resp.stop_reason == "max_tokens":
        logger.warning("Anthropic response truncated by max_tokens")
        raise AIGatewayError("Anthropic response truncated")

    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if not text:
        raise AIGatewayError("Anthropic returned empty content")

    return {
        "content": text,
        "model": resp.model,
        "total_ms": int((time.monotonic() - t0) * 1000),
    }


async def call_scenario_turn(*, system: str, message: str) -> dict:
    """Компактный вызов для AI-эскалации сценарного чата (Trade-In/бизнес/опт).

    Без structured outputs (`output_config`): ответ короткий (type/value/reply),
    JSON гарантирован промптом + repair-парсером `parse_scenario_turn` — заводить
    вторую JSON-схему ради трёх полей избыточно. Контракт возврата такой же, как
    у `call_anthropic`/`call_gateway`: {content, model, total_ms}.
    """
    if not settings.AI_ANTHROPIC_API_KEY:
        raise AIGatewayError("Anthropic is not configured (AI_ANTHROPIC_API_KEY)")

    t0 = time.monotonic()
    try:
        resp = await _client().messages.create(
            model=settings.AI_ANTHROPIC_MODEL,
            max_tokens=300,
            system=system,
            messages=[{"role": "user", "content": message}],
        )
    except anthropic.RateLimitError as e:
        logger.warning("Anthropic rate limited (scenario turn)")
        raise AIGatewayError("Anthropic rate limited") from e
    except anthropic.APIStatusError as e:
        logger.warning("Anthropic HTTP %s (scenario turn)", e.status_code)
        raise AIGatewayError(f"Anthropic returned HTTP {e.status_code}") from e
    except anthropic.APIConnectionError as e:
        logger.warning("Anthropic unreachable (scenario turn): %s", type(e).__name__)
        raise AIGatewayError("Anthropic unreachable") from e

    if resp.stop_reason == "refusal":
        logger.warning("Anthropic refused the request (scenario turn)")
        raise AIGatewayError("Anthropic refused the request")
    if resp.stop_reason == "max_tokens":
        logger.warning("Anthropic response truncated by max_tokens (scenario turn)")
        raise AIGatewayError("Anthropic response truncated")

    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if not text:
        raise AIGatewayError("Anthropic returned empty content")

    return {
        "content": text,
        "model": resp.model,
        "total_ms": int((time.monotonic() - t0) * 1000),
    }
