"""Заявка «Предложить товар» (lead_type=sell_item) — см.
docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md."""
import io

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.core import rate_limit
from app.db.session import get_db
from app.main import app
from app.models.user import User


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """In-memory окно лимитера живёт в процессе — чистим между тестами, иначе
    низкий дневной лимит в одном тесте ловит запросы соседнего (оба используют
    user_id=1 из ctx-фикстуры: см. tests/test_api_routes.py)."""
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


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


def test_upload_marketplace_photo(ctx):
    client, _db, _u = ctx
    r = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("photo.jpg", io.BytesIO(b"\xff\xd8\xff" + b"0" * 100), "image/jpeg")},
    )
    assert r.status_code == 201
    assert r.json()["url"].startswith("/api/uploads/")


def test_upload_marketplace_photo_rejects_bad_type(ctx):
    client, _db, _u = ctx
    r = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("file.txt", io.BytesIO(b"not an image"), "text/plain")},
    )
    assert r.status_code == 400


def test_upload_marketplace_photo_rate_limited(ctx, monkeypatch):
    client, _db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.SELL_ITEM_UPLOAD_DAILY_LIMIT_PER_USER", 1)
    ok = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("photo.jpg", io.BytesIO(b"\xff\xd8\xff" + b"0" * 100), "image/jpeg")},
    )
    assert ok.status_code == 201
    blocked = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("photo.jpg", io.BytesIO(b"\xff\xd8\xff" + b"0" * 100), "image/jpeg")},
    )
    assert blocked.status_code == 429
