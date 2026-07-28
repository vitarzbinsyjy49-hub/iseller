"""AI Gateway основного бэкенда.

Поток: Mini App -> POST /api/ai/chat (JWT) -> AI Engine (X-API-Key) -> ответ.
Если AI Engine недоступен/сломан/медленный — fallback на обычный поиск
по каталогу, ответ в ТОМ ЖЕ формате (фронтенд не различает источники,
только по meta.source).

Инварианты безопасности:
- Mini App никогда не ходит в AI Engine напрямую.
- user_id для AI Engine формирует ТОЛЬКО этот слой из проверенного JWT.
- AI Engine не видит Telegram initData и не занимается авторизацией.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.catalog import search_products
from app.api.deps import client_ip, get_current_user
from app.core.config import settings
from app.core.rate_limit import check_rate_limit
from app.db.session import get_db
from app.models.analytics_event import AnalyticsEvent
from app.models.user import User
from app.schemas.ai import MAX_MESSAGE_LEN, AiChatIn
from app.services.ai_client import AIEngineError, ai_chat
from app.services.ai_provider import build_demo_answer

logger = logging.getLogger("techshop.ai")
router = APIRouter(prefix="/ai", tags=["ai"])


def _log_event(db: Session, user_id: int, event: str, payload: dict) -> None:
    """Серверные события AI-воронки. Ошибка аналитики не должна ронять запрос."""
    try:
        db.add(AnalyticsEvent(user_id=user_id, event=event, payload=payload))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Failed to log analytics event %s", event)


@router.post("/chat")
async def chat(
    body: AiChatIn,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Rate limit (v2): ключ = user_id, fallback на IP. При превышении — 429.
    # Лимитер fail-open и не затрагивает fallback-поиск: он лишь решает,
    # пускать ли запрос в обработку вообще.
    rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
    if not check_rate_limit(rl_key):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many AI requests. Please try again later.",
        )

    message = body.message.strip()
    if not message:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Пустой запрос")
    if len(message) > MAX_MESSAGE_LEN:  # подстраховка поверх pydantic
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Слишком длинный запрос")

    _log_event(db, user.id, "ai_query_submitted", {"length": len(message)})

    answer: dict
    ai_error: str | None = None
    mode = (settings.AI_PROVIDER or "fallback").lower()
    if mode in ("ollama_remote", "anthropic"):
        # v5: локальный AI-консультант (Mac mini + Ollama через AI Gateway).
        # v5.7: он же, но транспорт — Anthropic Messages API (AI_PROVIDER=anthropic).
        # Оркестратор сам деградирует в fallback — сюда ошибки не долетают,
        # кроме случая AI_FALLBACK_ENABLED=false (тогда честный 503).
        from app.services.ai_orchestrator import answer_via_local_ai
        try:
            history = [h.model_dump() for h in body.history]
            answer = await answer_via_local_ai(db, message, history)
        except Exception:
            logger.exception("Local AI failed and fallback is disabled")
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                                "AI-консультант временно недоступен, попробуйте позже.")
    elif mode == "ai":
        try:
            # user_id для AI Engine = внутренний id основного проекта (DataContract §1).
            answer = await ai_chat(str(user.id), message)
            answer.setdefault("meta", {})["source"] = "ai"
        except AIEngineError as e:
            logger.warning("AI fallback for user %s: %s", user.id, e)
            ai_error = str(e)[:200]
            answer = build_demo_answer(db, message, source="fallback")
    else:
        # mock / fallback — не трогаем AI Engine, отвечаем по каталогу (быстро, без ключей).
        answer = build_demo_answer(db, message, source="mock" if mode == "mock" else "fallback")

    answer.setdefault("meta", {})
    # Privacy (v5.1.1): сырой текст запроса НЕ сохраняется ни в аналитике, ни в
    # логах — только безопасные метаданные (длина/источник/интент/латентность).
    _log_event(db, user.id, "ai_response_received", {
        "source": answer["meta"].get("source"),
        "intent": answer["meta"].get("intent"),
        "cards": len(answer.get("cards", [])),
        "query_length": len(message),
        "analytics_id": answer["meta"].get("analytics_id"),
        "latency_ms": answer["meta"].get("latency_ms"),
        "error": ai_error,
    })
    return answer
