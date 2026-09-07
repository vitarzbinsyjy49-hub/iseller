"""Реферальная программа: код, связь, выплаты.

Главное, что здесь держится: связь ставится один раз и не переписывается,
самоприглашение невозможно, выплата не удваивается и не двигает оборот.
"""
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app

# Импорт наверху, а не внутри теста: он регистрирует таблицы (в том числе
# audit_logs), а create_all в фикстуре db выполняется раньше тела теста.
from app.api.auth import _get_or_create_user
from app.models.user import User


@pytest.fixture()
def admin_client(db):
    """Менеджер, завершающий заявки: выплаты идут из PATCH /admin/leads."""
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _pair(db, inviter_tid: int, invited_tid: int) -> tuple[User, User]:
    """Пара «пригласивший — приглашённый» со связью."""
    inviter = User(telegram_id=inviter_tid)
    invited = User(telegram_id=invited_tid)
    db.add_all([inviter, invited])
    db.commit()
    db.refresh(inviter)
    db.refresh(invited)
    invited.referred_by_user_id = inviter.id
    db.commit()
    return inviter, invited


def _complete(admin_client, db, buyer: User, total: float):
    """Завести заявку покупателя и завершить её итоговой суммой."""
    from app.models.lead import Lead

    lead = Lead(status="confirmed", user_id=buyer.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    resp = admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": total},
    )
    return lead, resp


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


# ------------------------------------------------- проведение выплат

def test_inviter_gets_percent_and_invited_gets_welcome(admin_client, db):
    from app.services import loyalty

    inviter, invited = _pair(db, 920, 921)
    _complete(admin_client, db, invited, 100_000)

    assert loyalty.summary(db, inviter.id)["balance"] == 1000       # 1%
    # 250 собственного кэшбека «Старта» + 1000 приветственных
    assert loyalty.summary(db, invited.id)["balance"] == 1250
    # Реферальный доход не двигает оборот: уровень так не поднять.
    assert loyalty.summary(db, inviter.id)["lifetime_spent"] == 0


def test_second_purchase_pays_percent_but_not_welcome(admin_client, db):
    from app.services import loyalty

    inviter, invited = _pair(db, 922, 923)
    for _ in range(2):
        _complete(admin_client, db, invited, 100_000)

    assert loyalty.summary(db, inviter.id)["balance"] == 2000       # 1% дважды
    # 250 + 250 кэшбека и ОДИН приветственный бонус
    assert loyalty.summary(db, invited.id)["balance"] == 1500


def test_zero_percent_creates_no_transaction(admin_client, db):
    """С покупки дешевле 100 рублей платить нечего, и это не ошибка:
    record() запрещает операции на ноль баллов."""
    from app.services import loyalty

    inviter, invited = _pair(db, 924, 925)
    _lead, resp = _complete(admin_client, db, invited, 50)

    assert resp.status_code == 200
    assert loyalty.summary(db, inviter.id)["balance"] == 0


def test_revert_takes_back_referral_payouts(admin_client, db):
    from app.services import loyalty

    inviter, invited = _pair(db, 926, 927)
    lead, _resp = _complete(admin_client, db, invited, 100_000)

    admin_client.patch(f"/api/admin/leads/{lead.id}", json={"status": "cancelled"})

    assert loyalty.summary(db, inviter.id)["balance"] == 0
    assert loyalty.summary(db, invited.id)["balance"] == 0


def test_inviter_is_notified_once(admin_client, db, monkeypatch):
    """Двойное сохранение статуса не должно слать второе сообщение —
    dedupe_key привязан к заявке и попытке, как у статусов заявки."""
    from sqlalchemy import select

    from app.models.notification import Notification

    # Без токена бота уведомления намеренно не ставятся в очередь вовсе
    # (см. notifications_enabled) — тот же приём, что в test_notifications.py.
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")

    inviter, invited = _pair(db, 930, 931)
    lead, _resp = _complete(admin_client, db, invited, 100_000)
    admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )

    rows = db.execute(
        select(Notification).where(Notification.chat_id == inviter.telegram_id)
    ).scalars().all()
    assert len(rows) == 1, "двойное сохранение не должно слать второе сообщение"
    assert "1000" in rows[0].text


# ------------------------------------------------- экран приглашений

def _user_client(db, user: User) -> TestClient:
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    return TestClient(app)


def test_referral_me_returns_link_and_totals(admin_client, db, monkeypatch):
    """Условия отдаются вместе со счётом: экран обязан назвать их полностью и
    заранее — роудмап обещает «без условий, которые видно только в конце»."""
    monkeypatch.setattr("app.core.config.settings.BOT_USERNAME", "@iseller_bot")

    inviter, invited = _pair(db, 940, 941)
    _complete(admin_client, db, invited, 100_000)

    client = _user_client(db, inviter)
    try:
        data = client.get("/api/referral/me").json()
    finally:
        app.dependency_overrides.clear()

    assert len(data["code"]) == 8
    assert data["link"] == f"https://t.me/iseller_bot?start=ref_{data['code']}"
    assert data["invited_count"] == 1
    # 1000 баллов процента. Приветственный бонус приглашённого сюда не входит:
    # он про друга, а не про пригласившего.
    assert data["earned_points"] == 1000
    assert data["rate_percent"] == 1
    assert data["welcome_bonus_points"] == 1000


def test_referral_me_issues_code_on_first_open(db, monkeypatch):
    """Код выдаётся лениво — при первом открытии экрана, а не всем разом."""
    monkeypatch.setattr("app.core.config.settings.BOT_USERNAME", "iseller_bot")

    user = User(telegram_id=942)
    db.add(user)
    db.commit()
    db.refresh(user)
    assert user.referral_code is None

    client = _user_client(db, user)
    try:
        first = client.get("/api/referral/me").json()["code"]
        second = client.get("/api/referral/me").json()["code"]
    finally:
        app.dependency_overrides.clear()

    assert first == second
    db.refresh(user)
    assert user.referral_code == first


# ------------------------------------------------- наблюдаемость

def test_admin_sees_referral_pairs_sorted_by_payout(admin_client, db):
    """Сортировка по сумме выплат: накрутка всплывает наверх сама, без
    отдельного детектора."""
    small_inviter, small_invited = _pair(db, 950, 951)
    big_inviter, big_invited = _pair(db, 952, 953)

    _complete(admin_client, db, small_invited, 100_000)      # 1000 баллов
    _complete(admin_client, db, big_invited, 500_000)        # 5000 баллов

    rows = admin_client.get("/api/admin/referrals").json()["items"]
    assert len(rows) == 2
    assert rows[0]["inviter"]["id"] == big_inviter.id
    assert rows[0]["paid_points"] == 5000
    assert rows[0]["completed_leads"] == 1
    assert rows[0]["invited"]["id"] == big_invited.id
    assert rows[1]["inviter"]["id"] == small_inviter.id
    assert rows[1]["paid_points"] == 1000
    assert rows[0]["registered_at"] is not None


def test_pair_without_payouts_is_still_visible(admin_client, db):
    """Приглашённый, который ещё ничего не купил, из списка не исчезает:
    «пришли, но не покупают» — это тоже сигнал."""
    inviter, _invited = _pair(db, 954, 955)

    rows = admin_client.get("/api/admin/referrals").json()["items"]
    assert len(rows) == 1
    assert rows[0]["inviter"]["id"] == inviter.id
    assert rows[0]["completed_leads"] == 0
    assert rows[0]["paid_points"] == 0
