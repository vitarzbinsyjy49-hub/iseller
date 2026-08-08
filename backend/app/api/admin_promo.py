"""Промокоды в админке: создание, правка, выключение, расход.

GET    /api/admin/promo-codes                  — список с расходом по каждому
POST   /api/admin/promo-codes                  — создать
PATCH  /api/admin/promo-codes/{id}             — правка и выключение
DELETE /api/admin/promo-codes/{id}             — удалить, только если не использован
GET    /api/admin/promo-codes/{id}/redemptions — кто применил и по какой заявке

Расход везде считается из журнала ``promo_redemptions`` одним групповым
запросом: строка на код в списке из полусотни кодов дала бы полсотни запросов.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.audit import AuditLog
from app.models.promo import PromoCode, PromoRedemption
from app.models.user import User
from app.services.promo import PromoError, normalize_code, used_count

router = APIRouter(prefix="/admin/promo-codes", tags=["admin-promo"])


class PromoIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    discount_amount: float = Field(gt=0, le=100_000_000)
    max_redemptions: int | None = Field(default=None, ge=1)
    min_order_amount: float | None = Field(default=None, ge=0)
    expires_at: datetime | None = None
    note: str | None = Field(default=None, max_length=2000)

    @field_validator("code")
    @classmethod
    def _code(cls, v: str) -> str:
        try:
            return normalize_code(v)
        except PromoError as exc:
            raise ValueError(str(exc)) from exc


class PromoPatch(BaseModel):
    """Всё необязательное: правится только присланное.

    Сам ``code`` менять нельзя. Люди уже унесли его в переписку и на бумагу;
    переименование кода задним числом ломает акцию у тех, кому его выдали.
    """

    discount_amount: float | None = Field(default=None, gt=0, le=100_000_000)
    max_redemptions: int | None = Field(default=None, ge=1)
    min_order_amount: float | None = Field(default=None, ge=0)
    expires_at: datetime | None = None
    is_active: bool | None = None
    note: str | None = Field(default=None, max_length=2000)


def _usage_map(db: Session, promo_ids: list[int]) -> dict[int, int]:
    if not promo_ids:
        return {}
    rows = db.execute(
        select(PromoRedemption.promo_id, func.count(PromoRedemption.id))
        .where(PromoRedemption.promo_id.in_(promo_ids))
        .group_by(PromoRedemption.promo_id)
    ).all()
    return {promo_id: int(count) for promo_id, count in rows}


@router.get("")
def list_codes(db: Session = Depends(get_db), admin: str = Depends(get_current_admin)):
    codes = db.execute(select(PromoCode).order_by(PromoCode.id.desc())).scalars().all()
    usage = _usage_map(db, [c.id for c in codes])
    return {"items": [c.to_dict(used=usage.get(c.id, 0)) for c in codes]}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_code(
    body: PromoIn,
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    promo = PromoCode(
        code=body.code,
        discount_amount=body.discount_amount,
        max_redemptions=body.max_redemptions,
        min_order_amount=body.min_order_amount,
        expires_at=body.expires_at,
        note=(body.note or "").strip() or None,
        is_active=True,
    )
    db.add(promo)
    db.add(AuditLog(
        actor=f"admin:{admin}",
        action="promo_code_created",
        detail=f"code={body.code};amount={body.discount_amount};limit={body.max_redemptions}",
    ))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Такой код уже есть")
    db.refresh(promo)
    return promo.to_dict(used=0)


@router.patch("/{promo_id}")
def update_code(
    promo_id: int,
    body: PromoPatch,
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    promo = db.get(PromoCode, promo_id)
    if promo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Промокод не найден")

    changed = body.model_dump(exclude_unset=True)
    for field, value in changed.items():
        setattr(promo, field, value)

    if changed:
        # Выключение акции и правка размера скидки — действия, о которых через
        # неделю обязательно спросят «кто это сделал».
        db.add(AuditLog(
            actor=f"admin:{admin}",
            action="promo_code_updated",
            detail=f"code={promo.code};" + ";".join(f"{k}={v}" for k, v in changed.items()),
        ))
    db.commit()
    db.refresh(promo)
    return promo.to_dict(used=used_count(db, promo.id))


@router.delete("/{promo_id}")
def delete_code(
    promo_id: int,
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    promo = db.get(PromoCode, promo_id)
    if promo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Промокод не найден")

    if used_count(db, promo.id) > 0:
        # История применений дороже чистоты списка: удалив код, мы потеряли бы
        # ответ на вопрос «кому и за что дали скидку». Такие коды выключают.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Код уже применяли — его можно выключить, но не удалить",
        )

    db.delete(promo)
    db.add(AuditLog(actor=f"admin:{admin}", action="promo_code_deleted", detail=f"code={promo.code}"))
    db.commit()
    return {"ok": True}


@router.get("/{promo_id}/redemptions")
def list_redemptions(
    promo_id: int,
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    promo = db.get(PromoCode, promo_id)
    if promo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Промокод не найден")

    rows = db.execute(
        select(PromoRedemption)
        .where(PromoRedemption.promo_id == promo_id)
        .order_by(PromoRedemption.id.desc())
    ).scalars().all()

    # Имена берём одним запросом: строку журнала нужно связать с человеком, а не
    # показывать менеджеру голый user_id.
    users = {
        u.id: u
        for u in db.execute(
            select(User).where(User.id.in_([r.user_id for r in rows]))
        ).scalars().all()
    } if rows else {}

    items = []
    for row in rows:
        user = users.get(row.user_id)
        items.append({
            **row.to_dict(),
            "username": user.username if user else None,
            "name": user.first_name if user else None,
        })
    return {"items": items, "code": promo.code}
