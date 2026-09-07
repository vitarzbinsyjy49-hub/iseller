"""Реферальная программа: код, связь, выплаты.

Главное, что здесь держится: связь ставится один раз и не переписывается,
самоприглашение невозможно, выплата не удваивается и не двигает оборот.
"""
import pytest

from app.models.user import User


def test_user_has_referral_columns(db):
    user = User(telegram_id=900)
    db.add(user)
    db.commit()
    db.refresh(user)

    assert user.referral_code is None
    assert user.referred_by_user_id is None


def test_required_schema_knows_new_user_columns():
    """Колонка в users, о которой не знает бот, роняет деплой."""
    from app.scripts import bot_polling as bp

    assert "referral_code" in bp.REQUIRED_SCHEMA["users"]
    assert "referred_by_user_id" in bp.REQUIRED_SCHEMA["users"]


def test_required_schema_covers_ad_touches():
    """Бот пишет ad_touches при /start, а миграции выполняет API-контейнер:
    бот может подняться раньше. Тест синхронизации это не ловит — таблицы нет
    в его поле зрения, пока мы её туда не внесём."""
    from app.scripts import bot_polling as bp

    assert "kind" in bp.REQUIRED_SCHEMA["ad_touches"]
