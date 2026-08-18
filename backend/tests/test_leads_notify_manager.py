"""Менеджер получает Telegram-алерт о ЛЮБОЙ новой заявке, не только
price_offer/sell_item — см.
docs/superpowers/specs/2026-08-18-lead-cancellation-design.md."""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.notification import Notification
from app.models.user import User


@pytest.fixture()
def ctx(db):
    user = User(telegram_id=801, first_name="Гарик", username="garik")
    db.add(user)
    db.commit()
    db.refresh(user)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    try:
        yield TestClient(app), db, user
    finally:
        app.dependency_overrides.clear()


def test_general_lead_notifies_manager(ctx, monkeypatch):
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")
    r = client.post("/api/leads", json={
        "source": "product", "product_title": "Dyson HD16", "phone": "+79990000005",
    })
    assert r.status_code == 201

    notif = db.query(Notification).filter_by(kind="new_lead").first()
    assert notif is not None
    assert "Dyson HD16" in notif.text


def test_trade_in_lead_notification_is_tagged(ctx, monkeypatch):
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")
    r = client.post("/api/leads", json={
        "source": "home", "lead_type": "trade_in", "message": "Меняю на новый",
    })
    assert r.status_code == 201

    notif = db.query(Notification).filter_by(kind="new_lead").first()
    assert notif is not None
    assert "Trade-In" in notif.text


def test_price_offer_lead_does_not_get_generic_notification(ctx, monkeypatch):
    """price_offer уже шлёт своё специфичное уведомление (_notify_owner) —
    второе, общее, было бы дублем ни о чём не говорящим менеджеру больше."""
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")
    r = client.post("/api/leads", json={
        "source": "product", "product_id": None, "lead_type": "price_offer",
        "metadata": {"competitor_url": "https://market.yandex.ru/product/123", "competitor_price": 90000},
    })
    assert r.status_code == 201
    assert db.query(Notification).filter_by(kind="new_lead").count() == 0
    assert db.query(Notification).filter_by(kind="price_offer").count() == 1


def test_no_admin_chat_id_means_no_notification(ctx, monkeypatch):
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "")
    r = client.post("/api/leads", json={"source": "product", "product_title": "Что-то"})
    assert r.status_code == 201
    assert db.query(Notification).filter_by(kind="new_lead").count() == 0


def test_notifications_disabled_means_no_new_lead_notification(ctx, monkeypatch):
    """admin_chat_id() настроен (менеджер есть), но общий рубильник
    notifications_enabled() выключен (нет токена бота) — _notify_new_lead
    обязан промолчать так же, как _notify_status_change в admin_crm.py, а не
    поставить сообщение в очередь, которая никогда не сольётся без токена."""
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "")
    r = client.post("/api/leads", json={"source": "product", "product_title": "Что-то"})
    assert r.status_code == 201
    assert db.query(Notification).filter_by(kind="new_lead").count() == 0
