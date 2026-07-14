"""Приём событий продуктовой аналитики от Mini App.

Фронтенд шлёт только UI-события (открыл AI-чат, увидел карточку, кликнул).
Серверные события (ai_query_submitted, ai_response_received) пишет сам
backend в app/api/ai.py — им фронтенду доверять нельзя.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.models.analytics_event import AnalyticsEvent
from app.models.user import User
from app.schemas.ai import ALLOWED_EVENTS, EventIn

router = APIRouter(prefix="/events", tags=["events"])


@router.post("", status_code=status.HTTP_202_ACCEPTED)
def track(body: EventIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.event not in ALLOWED_EVENTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown event")
    db.add(AnalyticsEvent(user_id=user.id, event=body.event, payload=body.payload))
    db.commit()
    return {"ok": True}


@router.get("/recent", dependencies=[Depends(get_current_admin)])
def recent(db: Session = Depends(get_db), limit: int = 100):
    """Быстрый просмотр AI-воронки из админки."""
    limit = min(limit, 500)
    rows = db.execute(select(AnalyticsEvent).order_by(AnalyticsEvent.id.desc()).limit(limit)).scalars().all()
    return [
        {"id": r.id, "user_id": r.user_id, "event": r.event, "payload": r.payload,
         "created_at": r.created_at.isoformat()}
        for r in rows
    ]
