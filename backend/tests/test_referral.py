"""Реферальная программа: код, связь, выплаты.

Главное, что здесь держится: связь ставится один раз и не переписывается,
самоприглашение невозможно, выплата не удваивается и не двигает оборот.
"""
import pytest
from starlette.requests import Request

# Импорт наверху, а не внутри теста: он регистрирует таблицы (в том числе
# audit_logs), а create_all в фикстуре db выполняется раньше тела теста.
from app.api.auth import _get_or_create_user
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


# ------------------------------------------------- захват связи при регистрации

def _login(db, telegram_id: int, start_param: str | None = None) -> User:
    """Логин Mini App — тем же приёмом, что в test_ad_attribution.py."""
    request = Request({
        "type": "http", "method": "POST", "path": "/api/auth/telegram",
        "headers": [], "client": ("127.0.0.1", 1234),
    })
    tg_user = {"id": telegram_id, "username": "olya", "first_name": "Оля", "last_name": None}
    return _get_or_create_user(db, tg_user, request, start_param=start_param)


def test_referral_link_binds_new_user(db):
    """Связь ставится при СОЗДАНИИ пользователя и пишется в источник тем же
    форматом, что рекламные метки, — чтобы фильтр админки работал без правок."""
    from app.services import referral

    inviter = User(telegram_id=910)
    db.add(inviter)
    db.commit()
    db.refresh(inviter)
    code = referral.code_for(db, inviter)

    invited = _login(db, telegram_id=911, start_param=f"ref_{code}")

    assert invited.referred_by_user_id == inviter.id
    assert invited.acquisition_source == f"ref_{code}"


def test_existing_user_is_not_rebound(db):
    """Повторный заход по чужой ссылке не имеет права присвоить себе человека —
    то же правило, что у рекламной метки."""
    from app.services import referral

    inviter = User(telegram_id=912)
    db.add(inviter)
    db.commit()
    db.refresh(inviter)
    code = referral.code_for(db, inviter)

    _login(db, telegram_id=913)
    again = _login(db, telegram_id=913, start_param=f"ref_{code}")
    assert again.referred_by_user_id is None


def test_self_referral_is_refused(db):
    """Дешёвая проверка, на которую нельзя полагаться «этого не может быть»:
    речь о деньгах."""
    from app.services import referral

    user = _login(db, telegram_id=914)
    code = referral.code_for(db, user)

    again = _login(db, telegram_id=914, start_param=f"ref_{code}")
    assert again.referred_by_user_id is None


def test_unknown_code_is_not_an_error(db):
    invited = _login(db, telegram_id=915, start_param="ref_zzzzzzzz")
    assert invited.referred_by_user_id is None
    assert invited.acquisition_source is None


def test_ref_touch_in_chat_binds_on_first_login(db):
    """Telegram не прокидывает start_param в Mini App, открытый из чата, —
    метка доходит только первым касанием, и вид у него «ref», а не «ad»."""
    from app.services import ad_touch, referral

    inviter = User(telegram_id=916)
    db.add(inviter)
    db.commit()
    db.refresh(inviter)
    code = referral.code_for(db, inviter)

    ad_touch.remember(db, 917, code, kind="ref")
    invited = _login(db, telegram_id=917)

    assert invited.referred_by_user_id == inviter.id
    # Реферальное касание не имеет права стать рекламным источником.
    assert invited.acquisition_source == f"ref_{code}"


# ------------------------------------------------- расчёт выплат

def test_payout_points_rounds_down():
    from app.services import referral

    assert referral.payout_points(100_000, 100) == 1000   # 1%
    assert referral.payout_points(100_000, 250) == 2500   # 2,5%
    # Округление ВНИЗ: вверх дарило бы по баллу на каждой операции, и на
    # длинной истории это заметные деньги. Тот же приём, что в points_for.
    assert referral.payout_points(999, 100) == 9
    # С покупки дешевле 100 рублей при ставке 1% платить нечего.
    assert referral.payout_points(99, 100) == 0
    assert referral.payout_points(100_000, 0) == 0
    assert referral.payout_points(None, 100) == 0
