"""Приём событий продуктовой аналитики от Mini App.

Фронтенд шлёт только UI-события (открыл AI-чат, увидел карточку, кликнул).
Серверные события (ai_query_submitted, ai_response_received) пишет сам
backend в app/api/ai.py — им фронтенду доверять нельзя.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.models.analytics_event import AnalyticsEvent
from app.models.product import Product
from app.models.user import User
from app.models.user_product_event import EVENT_TYPES
from app.schemas.ai import ALLOWED_EVENTS, EventIn
from app.services.recommendations import record_event

router = APIRouter(prefix="/events", tags=["events"])


@router.post("", status_code=status.HTTP_202_ACCEPTED)
def track(body: EventIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.event not in ALLOWED_EVENTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown event")
    db.add(AnalyticsEvent(user_id=user.id, event=body.event, payload=body.payload))
    db.commit()
    return {"ok": True}


class ProductEventIn(BaseModel):
    """Поведенческое событие для рекомендаций. Принадлежит только текущему user_id
    (из JWT); за другого записать нельзя. Тип — из allowlist, product_id валиден."""
    event_type: str = Field(min_length=1, max_length=32)
    product_id: int | None = None
    category: str | None = Field(default=None, max_length=100)
    query: str | None = Field(default=None, max_length=200)
    source: str | None = Field(default=None, max_length=40)


@router.post("/product", status_code=status.HTTP_202_ACCEPTED)
def track_product(body: ProductEventIn, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """UI-события пользователя (просмотр товара/категории, поиск, клик по
    рекомендации). Серверные сигналы (избранное/заявка) пишет сам backend."""
    if body.event_type not in EVENT_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown event_type")
    if body.product_id is not None and db.get(Product, body.product_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    recorded = record_event(db, user.id, body.event_type, product_id=body.product_id,
                            category=body.category, query=body.query, source=body.source)
    return {"ok": True, "recorded": recorded}


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
