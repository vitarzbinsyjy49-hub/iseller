"""Пользователь отменяет свою заявку — см.
docs/superpowers/specs/2026-08-18-lead-cancellation-design.md."""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.audit import AuditLog
from app.models.lead import Lead
from app.models.notification import Notification
from app.models.user import User


@pytest.fixture()
def ctx(db):
    owner = User(telegram_id=701, first_name="Настя", username="nastya")
    stranger = User(telegram_id=702, first_name="Чужой", username="stranger")
    db.add_all([owner, stranger])
    db.commit()
    db.refresh(owner)
    db.refresh(stranger)
    holder = {"uid": owner.id}

    def override_db():
        yield db

    def override_user():
        return db.get(User, holder["uid"])

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    try:
        yield TestClient(app), db, holder, owner, stranger
    finally:
        app.dependency_overrides.clear()


def make_lead(db, user, **kw) -> Lead:
    defaults = dict(
        user_id=user.id, telegram_id=user.telegram_id, username=user.username,
        status="new", source="home", product_title="iPhone 17 Pro",
    )
    defaults.update(kw)
    lead = Lead(**defaults)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def test_owner_can_cancel_new_lead(ctx):
    client, db, _holder, owner, _stranger = ctx
    lead = make_lead(db, owner, status="new")

    r = client.post(f"/api/leads/{lead.id}/cancel")
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    db.refresh(lead)
    assert lead.status == "cancelled"


@pytest.mark.parametrize("status", ["contacted", "confirming", "confirmed", "in_progress", "reserved"])
def test_owner_can_cancel_any_non_final_status(ctx, status):
    client, db, _holder, owner, _stranger = ctx
    lead = make_lead(db, owner, status=status)

    r = client.post(f"/api/leads/{lead.id}/cancel")
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"


@pytest.mark.parametrize("status", ["completed", "cancelled"])
def test_cannot_cancel_final_status(ctx, status):
    client, db, _holder, owner, _stranger = ctx
    lead = make_lead(db, owner, status=status)

    r = client.post(f"/api/leads/{lead.id}/cancel")
    assert r.status_code == 400
    db.refresh(lead)
    assert lead.status == status  # не тронут


def test_stranger_cannot_cancel_someone_elses_lead(ctx):
    client, db, holder, owner, stranger = ctx
    lead = make_lead(db, owner, status="new")
    holder["uid"] = stranger.id

    r = client.post(f"/api/leads/{lead.id}/cancel")
    assert r.status_code == 404
    db.refresh(lead)
    assert lead.status == "new"  # не тронут


def test_cancel_nonexistent_lead_is_404(ctx):
    client, *_ = ctx
    r = client.post("/api/leads/999999/cancel")
    assert r.status_code == 404


def test_cancel_writes_audit_log_with_user_actor(ctx):
    client, db, _holder, owner, _stranger = ctx
    lead = make_lead(db, owner, status="new")

    client.post(f"/api/leads/{lead.id}/cancel")

    row = db.query(AuditLog).filter_by(action="lead_status_changed").first()
    assert row is not None
    assert row.actor == f"user:{owner.id}"
    assert row.detail == f"lead={lead.id};from=new;to=cancelled"


def test_cancel_notifies_manager(ctx, monkeypatch):
    client, db, _holder, owner, _stranger = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    lead = make_lead(db, owner, status="new", product_title="iPhone 13 Pro")

    client.post(f"/api/leads/{lead.id}/cancel")

    notif = db.query(Notification).filter_by(kind="lead_cancelled").first()
    assert notif is not None
    assert "iPhone 13 Pro" in notif.text
