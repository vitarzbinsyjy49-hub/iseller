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


def test_parse_ref_payload():
    from app.services.telegram_bot import parse_ref_payload

    assert parse_ref_payload("ref_A1b2C3d4") == "A1b2C3d4"
    assert parse_ref_payload("ad_direct") is None
    assert parse_ref_payload("product_42") is None
    assert parse_ref_payload("ref_") is None
    # Юникод-символы приходят мимо реальной ссылки: Telegram в start отдаёт
    # только ASCII-буквы, цифры, дефис и подчёркивание.
    assert parse_ref_payload("ref_абвгдежз") is None
    # Длина фиксирована: чужая строка нужной формы кодом не является.
    assert parse_ref_payload("ref_A1b2C3d4e5") is None


def test_ref_payload_fits_telegram_limit():
    """Лимит Telegram на start-параметр — 64 символа. У рекламных ссылок он
    выбран под ноль; реферальные обязаны остаться далеко внутри."""
    from app.services.telegram_bot import REF_CODE_LENGTH, REF_PAYLOAD_PREFIX

    assert len(REF_PAYLOAD_PREFIX) + REF_CODE_LENGTH <= 64


def test_code_is_issued_once_and_is_stable(db):
    from app.services import referral

    user = User(telegram_id=901)
    db.add(user)
    db.commit()
    db.refresh(user)

    first = referral.code_for(db, user)
    assert len(first) == 8
    assert referral.code_for(db, user) == first, "код обязан быть постоянным"


def test_code_resolves_back_to_user(db):
    from app.services import referral

    user = User(telegram_id=902)
    db.add(user)
    db.commit()
    db.refresh(user)

    code = referral.code_for(db, user)
    assert referral.user_by_code(db, code).id == user.id
    assert referral.user_by_code(db, "zzzzzzzz") is None
    assert referral.user_by_code(db, "") is None
