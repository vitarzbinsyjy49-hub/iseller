"""POST /api/scenario-chat/turn — AI-эскалация сценарного чата.

Вызывается фронтом ТОЛЬКО когда клиентский скрипт сам не смог разобрать ответ
покупателя — см. docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md.
Использует тот же rate-limit ключ, что /ai/chat: это тот же AI-бюджет
пользователя, отдельный счётчик не заводим.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.deps import client_ip, get_current_user
from app.core.rate_limit import check_rate_limit
from app.models.user import User
from app.schemas.ai import ScenarioChatTurnIn
from app.services.scenario_chat import answer_scenario_turn

router = APIRouter(prefix="/scenario-chat", tags=["scenario-chat"])


@router.post("/turn")
async def turn(
    body: ScenarioChatTurnIn,
    request: Request,
    user: User = Depends(get_current_user),
):
    rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
    if not check_rate_limit(rl_key):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many AI requests. Please try again later.",
        )
    options = [{"value": o.value, "label": o.label} for o in body.options]
    return await answer_scenario_turn(
        scenario=body.scenario, field_key=body.field_key, options=options, message=body.message,
    )
