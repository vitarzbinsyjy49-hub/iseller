"""Чтение настроек лояльности.

Отсутствие строки трактуется как значения по умолчанию, а не как ошибка: так
свежая база и база после отката ведут себя одинаково.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.loyalty_settings import LoyaltySettings


def loyalty(db: Session) -> LoyaltySettings:
    row = db.execute(
        select(LoyaltySettings).where(LoyaltySettings.id == 1)
    ).scalar_one_or_none()
    if row is not None:
        return row
    # Несохранённый объект со значениями по умолчанию: строки может не быть на
    # свежей базе, и это не повод падать.
    return LoyaltySettings(
        id=1, referral_rate_bps=100, welcome_bonus_points=1000, auto_accrual_enabled=True,
    )
