"""Настройки программы лояльности: чтение, запись, аудит.

GET /api/admin/settings/loyalty — текущие значения
PUT /api/admin/settings/loyalty — сохранить все три сразу

Каждое изменение попадает в аудит со старым и новым значением: ставка выплаты
— это деньги, и через полгода надо уметь ответить, кто и когда её поменял.
"""
from datetime import date

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
    referral_cap_points: int
    welcome_bonus_points: int
    auto_accrual_enabled: bool
    newcomer_enabled: bool
    newcomer_rate_bps: int
    newcomer_cap_points: int
    newcomer_until: date | None
    redeem_max_bps: int


def _to_dict(row: LoyaltySettings) -> dict:
    return {
        "referral_rate_bps": row.referral_rate_bps,
        "referral_cap_points": row.referral_cap_points,
        "welcome_bonus_points": row.welcome_bonus_points,
        "auto_accrual_enabled": bool(row.auto_accrual_enabled),
        "newcomer_enabled": bool(row.newcomer_enabled),
        "newcomer_rate_bps": row.newcomer_rate_bps,
        "newcomer_cap_points": row.newcomer_cap_points,
        "newcomer_until": row.newcomer_until.isoformat() if row.newcomer_until else None,
        "redeem_max_bps": row.redeem_max_bps,
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
    if not (0 <= body.newcomer_rate_bps <= 10_000):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Ставка акции должна быть от 0 до 10000 сотых процента",
        )
    # Потолок списания больше 100% означал бы заявку с отрицательной суммой.
    if not (0 <= body.redeem_max_bps <= 10_000):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Доля списания должна быть от 0 до 10000 сотых процента",
        )
    for name, value in (("newcomer_cap_points", body.newcomer_cap_points),
                        ("referral_cap_points", body.referral_cap_points)):
        if not (0 <= value <= 1_000_000):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Потолок {name} должен быть от 0 до 1000000 баллов",
            )
    # Акция без срока — это не акция, а новая постоянная ставка. Включить
    # бессрочную ставку через поле с надписью «акция» можно только по ошибке,
    # и заметят её не раньше, чем по расходу.
    if body.newcomer_enabled and body.newcomer_until is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "У акции обязан быть срок окончания",
        )

    row = db.execute(
        select(LoyaltySettings).where(LoyaltySettings.id == 1)
    ).scalar_one_or_none()
    if row is None:
        # Пустая строка: значения тут же перезапишутся телом запроса,
        # поэтому дублировать дефолты колонок незачем.
        row = LoyaltySettings(id=1)
        db.add(row)
    before = _to_dict(row)

    row.referral_rate_bps = body.referral_rate_bps
    row.referral_cap_points = body.referral_cap_points
    row.welcome_bonus_points = body.welcome_bonus_points
    row.auto_accrual_enabled = body.auto_accrual_enabled
    row.newcomer_enabled = body.newcomer_enabled
    row.newcomer_rate_bps = body.newcomer_rate_bps
    row.newcomer_cap_points = body.newcomer_cap_points
    row.newcomer_until = body.newcomer_until
    row.redeem_max_bps = body.redeem_max_bps

    db.add(AuditLog(
        actor=f"admin:{admin}",
        action="loyalty_settings_changed",
        detail=f"from={before};to={_to_dict(row)}",
    ))
    db.commit()
    db.refresh(row)
    return _to_dict(row)
