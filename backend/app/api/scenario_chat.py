"""POST /api/scenario-chat/turn — AI-эскалация сценарного чата.

Вызывается фронтом ТОЛЬКО когда клиентский скрипт сам не смог разобрать ответ
покупателя — см. docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md.
Делит тот же rate-limit ключ и тот же дневной AI-бюджет, что /ai/chat
(app/api/ai.py, AI_CHAT_DAILY_LIMIT_PER_USER) — отдельный счётчик не заводим.

Недоступность AI здесь НИКОГДА не даёт 429/5xx: этот эндпоинт — вспомогательный
шаг сценарного чата (см. услуги answer_scenario_turn, которая по той же причине
не бросает исключений), и его отказ не должен ронять флоу заявки. Поэтому
исчерпание минутного ИЛИ дневного лимита тихо деградирует в {"type":"unclear"}
— тот же контракт, что при недоступности гейтвея внутри answer_scenario_turn.
"""
from fastapi import APIRouter, Depends, Request

from app.api.deps import client_ip, get_current_user
from app.core.config import settings
from app.core.rate_limit import check_rate_limit
from app.models.user import User
from app.schemas.ai import ScenarioChatTurnIn
from app.services.scenario_chat import answer_scenario_turn

router = APIRouter(prefix="/scenario-chat", tags=["scenario-chat"])

_UNCLEAR: dict = {"type": "unclear", "value": None, "reply": None}


@router.post("/turn")
async def turn(
    body: ScenarioChatTurnIn,
    request: Request,
    user: User = Depends(get_current_user),
):
    rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
    if not check_rate_limit(rl_key):
        return dict(_UNCLEAR)
    daily_limit_reached = not check_rate_limit(
        f"ai_daily:{rl_key}", limit=settings.AI_CHAT_DAILY_LIMIT_PER_USER, window_seconds=86400,
    )
    if daily_limit_reached:
        return dict(_UNCLEAR)
    options = [{"value": o.value, "label": o.label} for o in body.options]
    return await answer_scenario_turn(
        scenario=body.scenario, field_key=body.field_key, options=options, message=body.message,
    )
