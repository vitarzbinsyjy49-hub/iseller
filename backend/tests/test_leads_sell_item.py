"""Заявка «Предложить товар» (lead_type=sell_item) — см.
docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md."""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=601, first_name="Настя", username="nastya")
    db.add(u)
    db.commit()
    db.refresh(u)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, u
    finally:
        app.dependency_overrides.clear()


def test_sell_item_lead_saved(ctx):
    client, db, _u = ctx
    payload = {
        "source": "home",
        "lead_type": "sell_item",
        "phone": "+79990000001",
        "metadata": {
            "category": "смартфоны", "title": "iPhone 13 Pro 128 ГБ",
            "state": "Хорошее, есть следы", "price_wanted": 45000,
            "photos": ["/api/uploads/a.jpg", "/api/uploads/b.jpg"],
        },
    }
    r = client.post("/api/leads", json=payload)
    assert r.status_code == 201
    body = r.json()
    assert body["lead_type"] == "sell_item"
    assert body["metadata"]["title"] == "iPhone 13 Pro 128 ГБ"
    assert body["metadata"]["photos"] == ["/api/uploads/a.jpg", "/api/uploads/b.jpg"]
