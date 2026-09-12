"""Настройки лояльности: одна строка, значения по умолчанию, рубильник."""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.main import app
from app.models.user import User
from app.services import loyalty, settings


@pytest.fixture()
def admin_client(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def ctx(db):
    user = User(telegram_id=777, first_name="Гарик", username="garik")
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"user": user}


def _full_payload(**over) -> dict:
    body = {
        "referral_rate_bps": 100,
        "referral_cap_points": 1000,
        "welcome_bonus_points": 500,
        "auto_accrual_enabled": True,
        "newcomer_enabled": True,
        "newcomer_rate_bps": 300,
        "newcomer_cap_points": 1500,
        "newcomer_until": "2026-11-01",
        "redeem_max_bps": 500,
    }
    body.update(over)
    return body


def test_defaults_without_row(db):
    """Отсутствие строки — не ошибка: это значения по умолчанию."""
    s = settings.loyalty(db)
    assert s.referral_rate_bps == 100      # 1%
    assert s.referral_cap_points == 1000
    assert s.welcome_bonus_points == 500
    assert s.auto_accrual_enabled is True
    # Акция выключена: несохранённая строка не имеет права её включить.
    assert s.newcomer_enabled is False
    assert s.redeem_max_bps == 500         # 5% чека


def test_saved_values_win(db):
    from app.models.loyalty_settings import LoyaltySettings

    db.add(LoyaltySettings(id=1, referral_rate_bps=250, welcome_bonus_points=500,
                           auto_accrual_enabled=False))
    db.commit()

    s = settings.loyalty(db)
    assert s.referral_rate_bps == 250
    assert s.welcome_bonus_points == 500
    assert s.auto_accrual_enabled is False


def test_admin_reads_and_writes_settings(admin_client, db):
    assert admin_client.get("/api/admin/settings/loyalty").json()["referral_rate_bps"] == 100

    resp = admin_client.put(
        "/api/admin/settings/loyalty", json=_full_payload(referral_rate_bps=200))
    assert resp.status_code == 200
    assert settings.loyalty(db).referral_rate_bps == 200


def test_settings_change_is_audited(admin_client, db):
    from sqlalchemy import select

    from app.models.audit import AuditLog

    admin_client.put(
        "/api/admin/settings/loyalty", json=_full_payload(referral_rate_bps=300))
    rows = db.execute(
        select(AuditLog).where(AuditLog.action == "loyalty_settings_changed")
    ).scalars().all()
    assert len(rows) == 1
    assert "100" in rows[0].detail and "300" in rows[0].detail


def test_rate_must_be_sane(admin_client):
    for bad in (-1, 10_001):
        resp = admin_client.put(
            "/api/admin/settings/loyalty", json=_full_payload(referral_rate_bps=bad))
        assert resp.status_code == 400


def test_switch_off_stops_auto_accrual(admin_client, db, ctx):
    """Рубильник останавливает автоматику, но сумма и счётчик проставляются:
    это свойства заявки, а не начислений."""
    from app.models.lead import Lead
    from app.models.loyalty_settings import LoyaltySettings

    db.add(LoyaltySettings(id=1, referral_rate_bps=100, welcome_bonus_points=1000,
                           auto_accrual_enabled=False))
    db.commit()

    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(f"/api/admin/leads/{lead.id}",
                       json={"status": "completed", "final_total": 100_000})
    db.refresh(lead)
    assert float(lead.final_total) == 100_000
    assert lead.completion_seq == 1
    assert loyalty.summary(db, user.id)["balance"] == 0


# ------------------------------------------------- акция и потолки в админке

def test_admin_reads_and_writes_the_promo(admin_client):
    """Акцию должен включать человек в админке, а не факт деплоя."""
    saved = admin_client.put("/api/admin/settings/loyalty", json=_full_payload())
    assert saved.status_code == 200, saved.text
    data = saved.json()
    assert data["newcomer_enabled"] is True
    assert data["newcomer_rate_bps"] == 300
    assert data["newcomer_cap_points"] == 1500
    assert data["newcomer_until"] == "2026-11-01"
    assert data["redeem_max_bps"] == 500
    assert data["referral_cap_points"] == 1000

    assert admin_client.get("/api/admin/settings/loyalty").json() == data


def test_promo_without_a_date_is_refused(admin_client):
    """Акция без срока — это не акция, а новая постоянная ставка. Включить её
    молча и навсегда через поле с надписью «акция» нельзя."""
    resp = admin_client.put(
        "/api/admin/settings/loyalty", json=_full_payload(newcomer_until=None))
    assert resp.status_code == 400
    assert "срок" in resp.json()["detail"].lower()


def test_redeem_share_cannot_exceed_everything(admin_client):
    """Списать больше суммы заявки нельзя даже по ошибке настройки."""
    resp = admin_client.put(
        "/api/admin/settings/loyalty", json=_full_payload(redeem_max_bps=10_001))
    assert resp.status_code == 400


def test_caps_are_validated(admin_client):
    for field in ("newcomer_cap_points", "referral_cap_points"):
        resp = admin_client.put(
            "/api/admin/settings/loyalty", json=_full_payload(**{field: -1}))
        assert resp.status_code == 400, field


def test_settings_change_lands_in_audit(admin_client, db):
    from app.models.audit import AuditLog

    admin_client.put("/api/admin/settings/loyalty", json=_full_payload())
    row = db.query(AuditLog).filter_by(action="loyalty_settings_changed").first()
    assert row is not None
    # Ставка акции — это деньги: через полгода надо уметь ответить, кто включил.
    assert "newcomer_rate_bps" in row.detail
