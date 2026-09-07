"""Настройки лояльности: одна строка, значения по умолчанию, рубильник."""
from app.services import settings


def test_defaults_without_row(db):
    """Отсутствие строки — не ошибка: это значения по умолчанию."""
    s = settings.loyalty(db)
    assert s.referral_rate_bps == 100      # 1%
    assert s.welcome_bonus_points == 1000
    assert s.auto_accrual_enabled is True


def test_saved_values_win(db):
    from app.models.loyalty_settings import LoyaltySettings

    db.add(LoyaltySettings(id=1, referral_rate_bps=250, welcome_bonus_points=500,
                           auto_accrual_enabled=False))
    db.commit()

    s = settings.loyalty(db)
    assert s.referral_rate_bps == 250
    assert s.welcome_bonus_points == 500
    assert s.auto_accrual_enabled is False
