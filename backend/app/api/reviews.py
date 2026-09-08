"""Отзывы: чтение витриной и отправка покупателем.

GET  /api/reviews                     — одобренные отзывы (общая лента)
GET  /api/reviews/product/{id}        — одобренные отзывы товара + сводка
GET  /api/reviews/lead/{id}           — свой отзыв по своей заявке (форма)
POST /api/reviews/lead/{id}           — оставить/поправить отзыв

Чтение открыто (это витрина), отправка — только автору заявки. Проверка
владения обязательна и не сводится к «пришёл валидный токен»: без неё любой
авторизованный мог бы оставить отзыв по чужой покупке, и «подтверждено»
перестало бы что-либо значить.

Модерация живёт в admin_crm — там же, где менеджер и так работает с заявками.
"""
import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.lead import Lead
from app.models.review import Review
from app.models.user import User
from app.services import reviews as service

logger = logging.getLogger("techshop.reviews")
router = APIRouter(prefix="/reviews", tags=["reviews"])


def _own_lead(db: Session, lead_id: int, user: User) -> Lead:
    """Заявка пользователя, иначе 404.

    Именно 404, а не 403: чужая заявка для этого пользователя не существует, и
    отвечать «есть, но не твоя» значит подтверждать её существование.
    """
    lead = db.get(Lead, lead_id)
    if lead is None or (lead.user_id is not None and lead.user_id != user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заявка не найдена")
    return lead


@router.get("")
def list_reviews(db: Session = Depends(get_db),
                 limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    return {"items": [r.to_public() for r in service.approved(db, limit=limit, offset=offset)]}


@router.get("/product/{product_id}")
def product_reviews(product_id: int, db: Session = Depends(get_db),
                    limit: int = Query(20, ge=1, le=100)):
    return {
        **service.summary_for_product(db, product_id),
        "items": [r.to_public() for r in service.approved_for_product(db, product_id, limit=limit)],
    }


@router.get("/lead/{lead_id}")
def my_review(lead_id: int, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    """Что показать в форме: можно ли оставить отзыв и что уже написано."""
    lead = _own_lead(db, lead_id, user)
    row = db.scalar(select(Review).where(Review.lead_id == lead.id))
    return {
        "can_review": service.can_review(lead),
        "lead": {
            "id": lead.id,
            "public_number": lead.public_number,
            "product_id": lead.product_id,
            "product_title": lead.product_title,
            "items_count": lead.items_count or 0,
        },
        "review": row.to_admin() if row else None,
    }


@router.post("/lead/{lead_id}", status_code=status.HTTP_201_CREATED)
def submit_review(
    lead_id: int,
    rating: int = Body(..., embed=True),
    text: str | None = Body(None, embed=True),
    photos: list[str] | None = Body(None, embed=True),
    product_id: int | None = Body(None, embed=True),
    author_name: str | None = Body(None, embed=True),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lead = _own_lead(db, lead_id, user)
    try:
        row = service.submit(
            db, lead=lead, rating=rating, text=text, photos=photos,
            product_id=product_id, author_name=author_name,
        )
    except service.ReviewError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    db.commit()
    db.refresh(row)
    logger.info("отзыв по заявке %s принят на модерацию", lead.id)
    return row.to_admin()
