"""Настройки программы лояльности: чтение, запись, аудит.

GET /api/admin/settings/loyalty — текущие значения
PUT /api/admin/settings/loyalty — сохранить все три сразу

Каждое изменение попадает в аудит со старым и новым значением: ставка выплаты
— это деньги, и через полгода надо уметь ответить, кто и когда её поменял.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.audit import AuditLog
from app.models.loyalty_settings import LoyaltySettings
from app.services import settings as settings_service

router = APIRouter(prefix="/admin/settings", tags=["admin"])


class LoyaltySettingsIn(BaseModel):
    referral_rate_bps: int
    welcome_bonus_points: int
    auto_accrual_enabled: bool


def _to_dict(row: LoyaltySettings) -> dict:
    return {
        "referral_rate_bps": row.referral_rate_bps,
        "welcome_bonus_points": row.welcome_bonus_points,
        "auto_accrual_enabled": bool(row.auto_accrual_enabled),
    }


@router.get("/loyalty")
def read_loyalty_settings(
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    return _to_dict(settings_service.loyalty(db))


@router.put("/loyalty")
def write_loyalty_settings(
    body: LoyaltySettingsIn,
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    # Потолок 10000 bps = 100%: выплата больше суммы покупки — это опечатка,
    # а не намерение. Ноль допустим: способ выключить процент, оставив
    # приветственный бонус.
    if not (0 <= body.referral_rate_bps <= 10_000):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Ставка должна быть от 0 до 10000 сотых процента",
        )
    if not (0 <= body.welcome_bonus_points <= 1_000_000):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Приветственный бонус должен быть от 0 до 1000000 баллов",
        )

    row = db.execute(
        select(LoyaltySettings).where(LoyaltySettings.id == 1)
    ).scalar_one_or_none()
    if row is None:
        row = LoyaltySettings(
            id=1, referral_rate_bps=100, welcome_bonus_points=1000,
            auto_accrual_enabled=True,
        )
        db.add(row)
    before = _to_dict(row)

    row.referral_rate_bps = body.referral_rate_bps
    row.welcome_bonus_points = body.welcome_bonus_points
    row.auto_accrual_enabled = body.auto_accrual_enabled

    db.add(AuditLog(
        actor=f"admin:{admin}",
        action="loyalty_settings_changed",
        detail=f"from={before};to={_to_dict(row)}",
    ))
    db.commit()
    db.refresh(row)
    return _to_dict(row)
