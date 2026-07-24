"""Заявки (Lead / OrderRequest) — пользовательская часть.

POST /api/leads        — создать заявку (JWT). Пишет событие lead_created.
GET  /api/leads/my     — мои заявки (JWT), для экрана «Заявки» в Mini App.
"""
import logging

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.analytics_event import AnalyticsEvent
from app.models.lead import DEFAULT_LEAD_TYPE, DELIVERY_METHODS, LEAD_SOURCES, Lead
from app.models.product import Product
from app.models.user import User
from app.schemas.ai import LeadIn

logger = logging.getLogger("techshop.leads")
router = APIRouter(prefix="/leads", tags=["leads"])


@router.post("", status_code=status.HTTP_201_CREATED)
def create_lead(body: LeadIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # Название и цену товара берём из БД (не доверяем клиенту), если передан product_id.
    product_title = body.product_title
    product_price = None
    product_category = None
    if body.product_id:
        product = db.get(Product, body.product_id)
        if product:
            product_title = product.title
            product_price = product.price
            product_category = product.category

    lead = Lead(
        user_id=user.id,
        telegram_id=user.telegram_id,
        name=body.name or user.first_name,
        phone=body.phone,
        username=user.username,
        product_id=body.product_id,
        product_title=product_title,
        product_price=product_price,
        message=body.message,
        source=body.source if body.source in LEAD_SOURCES else "other",
        # lead_type/metadata уже нормализованы/очищены в схеме LeadIn.
        lead_type=body.lead_type or DEFAULT_LEAD_TYPE,
        meta=body.metadata or {},
        delivery_method=body.delivery_method if body.delivery_method in DELIVERY_METHODS else None,
        status="new",
    )
    db.add(lead)
    db.commit()
    db.refresh(lead)

    # Событие воронки (не роняем запрос при ошибке аналитики).
    # Payload — только безопасные метаданные: без телефона/имени/комментария/metadata.
    try:
        db.add(AnalyticsEvent(user_id=user.id, event="lead_created",
                              payload={"lead_id": lead.id, "source": lead.source,
                                       "lead_type": lead.lead_type, "product_id": lead.product_id}))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("analytics lead_created failed")

    # Сильный сигнал для персональных рекомендаций (заявка = высокий вес)
    try:
        from app.services.recommendations import record_event
        record_event(db, user.id, "lead_created", product_id=body.product_id,
                     category=product_category, source="lead")
    except Exception:
        db.rollback()
        logger.exception("rec lead_created event failed")

    return lead.to_dict()


@router.get("/my")
def my_leads(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(Lead).where(Lead.user_id == user.id).order_by(Lead.id.desc())
    ).scalars().all()
    return {"leads": [l.to_dict() for l in rows]}
