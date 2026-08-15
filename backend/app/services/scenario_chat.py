"""Оркестратор AI-эскалации сценарного чата (Trade-In/бизнес/опт).

Вызывается ТОЛЬКО когда клиентский скрипт (frontend/src/lib/scenarioChat.ts)
сам не смог разобрать ответ покупателя — см.
docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md. Никогда не
бросает исключение наружу: при любой недоступности AI возвращает
{"type": "unclear"}, чтобы экран чата продолжил работу без модели.

Поддерживает только AI_PROVIDER=anthropic (прод-транспорт) — реализация
Mac-mini гейтвея для сценарного чата вне скоупа этого патча.
"""
import logging
from functools import lru_cache
from pathlib import Path

from app.core.config import settings
from app.services.ai_orchestrator import _sanitize
from app.services.ai_remote import AIGatewayError
from app.services.ai_schemas import AiAnswerParseError, parse_scenario_turn

logger = logging.getLogger("techshop.ai.scenario_chat")
_PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "scenario_chat_system.md"

_UNCLEAR: dict = {"type": "unclear", "value": None, "reply": None}


@lru_cache(maxsize=1)
def _system_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _build_user_message(scenario: str, field_key: str, options: list[dict], message: str) -> str:
    parts = [f"СЦЕНАРИЙ: {scenario}", f"ТЕКУЩИЙ ВОПРОС АНКЕТЫ: {field_key}"]
    if options:
        variants = ", ".join(f'{{"value":"{o["value"]}","label":"{o["label"]}"}}' for o in options)
        parts.append(f"VARIANTS: [{variants}]")
    parts.append(f"ОТВЕТ ПОКУПАТЕЛЯ: {message}")
    return "\n".join(parts)


async def _call_transport(*, system: str, message: str) -> dict:
    """Единственная точка входа в сеть — подменяется в тестах.
    Импорт ленивый: модуль тянет SDK anthropic, который нужен только здесь."""
    from app.services import ai_anthropic
    return await ai_anthropic.call_scenario_turn(system=system, message=message)


async def answer_scenario_turn(*, scenario: str, field_key: str, options: list[dict], message: str) -> dict:
    """Возвращает {"type": "field_value"|"answer_question"|"unclear", "value", "reply"}.

    ``options`` — [{"value","label"}, ...] текущего chips-поля (пусто для
    свободного текста). Никогда не бросает исключение.
    """
    message = _sanitize(message, max_len=500)
    if not message:
        return dict(_UNCLEAR)
    if settings.AI_PROVIDER.lower() != "anthropic":
        return dict(_UNCLEAR)

    user_message = _build_user_message(scenario, field_key, options, message)
    try:
        gw = await _call_transport(system=_system_prompt(), message=user_message)
        parsed = parse_scenario_turn(gw["content"])
    except (AIGatewayError, AiAnswerParseError, OSError, ImportError) as e:
        logger.warning("Scenario chat AI degraded to unclear: %s", type(e).__name__)
        return dict(_UNCLEAR)
    except Exception:
        # Финальная страховка: контракт этой функции — НИКОГДА не бросать
        # исключение наружу (эндпоинт полагается на это целиком, своего
        # try/except у него нет). Специфичный except выше — для информативного
        # лога, этот — сеть на случай непредвиденных сбоев SDK
        # (anthropic.APIResponseValidationError и подобные), которые иначе
        # стали бы необработанным 500 и сломали бы «AI никогда не блокирует
        # отправку заявки».
        logger.exception("Scenario chat AI degraded to unclear: unexpected error")
        return dict(_UNCLEAR)

    allowed_values = {o["value"] for o in options}
    if parsed.type == "field_value" and parsed.value not in allowed_values:
        logger.warning("Scenario chat LLM returned value outside options — dropped")
        return dict(_UNCLEAR)

    return {"type": parsed.type, "value": parsed.value, "reply": parsed.reply}
