"""Заявка «Предложить товар» (lead_type=sell_item) — см.
docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md."""
import io

import pytest
from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile

from app.api.deps import get_current_admin, get_current_user
from app.core import rate_limit
from app.core.uploads import MAX_BYTES, MAX_PRODUCT_IMAGES
from app.db.session import get_db
from app.main import app
from app.models.notification import Notification
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


def test_sell_item_photos_keep_only_own_uploads(ctx):
    """metadata приходит от клиента, а фото из неё показываются модератору
    ссылкой (<a href>) и уезжают в images товара при публикации. Значит
    javascript:/data:/чужой хост — это XSS на origin админки (там токены) и
    подмена картинки на витрине. Оставляем только свои /api/uploads/…,
    остальное молча выбрасываем: заявку это ронять не должно."""
    client, _db, _u = ctx
    payload = {
        "source": "home", "lead_type": "sell_item", "phone": "+79990000010",
        "metadata": {
            "category": "смартфоны", "title": "iPhone 13", "price_wanted": 40000,
            "photos": [
                "/api/uploads/good.jpg",
                "javascript:alert(1)",
                "https://evil.example/x.jpg",
                "/api/uploadsevil.jpg",       # префикс без разделителя — не наш файл
                123,
            ],
        },
    }
    r = client.post("/api/leads", json=payload)
    assert r.status_code == 201
    assert r.json()["metadata"]["photos"] == ["/api/uploads/good.jpg"]


def test_sell_item_photos_capped_at_limit(ctx):
    client, _db, _u = ctx
    payload = {
        "source": "home", "lead_type": "sell_item", "phone": "+79990000011",
        "metadata": {"category": "смартфоны", "title": "iPhone 13",
                     "photos": [f"/api/uploads/{i}.jpg" for i in range(MAX_PRODUCT_IMAGES + 5)]},
    }
    r = client.post("/api/leads", json=payload)
    assert r.status_code == 201
    assert len(r.json()["metadata"]["photos"]) == MAX_PRODUCT_IMAGES


def test_upload_marketplace_photo(ctx):
    client, _db, _u = ctx
    r = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("photo.jpg", io.BytesIO(b"\xff\xd8\xff" + b"0" * 100), "image/jpeg")},
    )
    assert r.status_code == 201
    assert r.json()["url"].startswith("/api/uploads/")


def test_upload_marketplace_photo_rejects_oversized(ctx):
    """Ручка публичная, а лимит частоты считает ЗАПРОСЫ, а не байты. Отказ
    обязан быть и по размеру, причём до чтения файла целиком."""
    client, _db, _u = ctx
    big = b"\xff\xd8\xff" + b"0" * MAX_BYTES
    r = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("huge.jpg", io.BytesIO(big), "image/jpeg")},
    )
    assert r.status_code == 400
    assert "8" in r.json()["detail"]


def test_upload_marketplace_photo_rejects_oversized_before_reading(ctx, monkeypatch):
    """Отказ обязан случиться по Content-Length, до чтения тела: иначе крупная
    загрузка сперва целиком ляжет во временный файл Starlette."""
    client, _db, _u = ctx

    async def boom(*a, **kw):
        raise AssertionError("тело прочитано до отказа по размеру")

    monkeypatch.setattr(UploadFile, "read", boom)
    big = b"\xff\xd8\xff" + b"0" * MAX_BYTES
    r = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("huge.jpg", io.BytesIO(big), "image/jpeg")},
    )
    assert r.status_code == 400


def test_upload_marketplace_photo_rejects_bad_type(ctx):
    client, _db, _u = ctx
    r = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("file.txt", io.BytesIO(b"not an image"), "text/plain")},
    )
    assert r.status_code == 400


def test_sell_item_notifies_admin(ctx, monkeypatch):
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")
    payload = {
        "source": "home", "lead_type": "sell_item", "phone": "+79990000002",
        "metadata": {"category": "смартфоны", "title": "iPhone 12", "price_wanted": 30000,
                      "photos": ["/api/uploads/a.jpg"]},
    }
    r = client.post("/api/leads", json=payload)
    assert r.status_code == 201
    notif = db.query(Notification).filter_by(kind="sell_item").first()
    assert notif is not None
    assert "iPhone 12" in notif.text


def test_sell_item_notifies_admin_with_non_numeric_price(ctx, monkeypatch):
    """price_wanted нечисловая строка не должна ронять создание заявки —
    уведомление модератору лишь nice-to-have, а не условие успеха запроса
    (в отличие от _competitor_price для price_offer, которая осознанно
    отклоняет заявку 422 при мусоре в цене — здесь модель другая)."""
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")
    payload = {
        "source": "home", "lead_type": "sell_item", "phone": "+79990000004",
        "metadata": {"category": "смартфоны", "title": "iPhone 11",
                      "price_wanted": "по договорённости",
                      "photos": ["/api/uploads/a.jpg"]},
    }
    r = client.post("/api/leads", json=payload)
    assert r.status_code == 201
    notif = db.query(Notification).filter_by(kind="sell_item").first()
    assert notif is not None
    assert "iPhone 11" in notif.text


def test_sell_item_rate_limited(ctx, monkeypatch):
    client, _db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.SELL_ITEM_DAILY_LIMIT_PER_USER", 1)
    payload = {
        "source": "home", "lead_type": "sell_item", "phone": "+79990000003",
        "metadata": {"category": "смартфоны", "title": "iPhone X", "price_wanted": 10000},
    }
    ok = client.post("/api/leads", json=payload)
    assert ok.status_code == 201
    blocked = client.post("/api/leads", json=payload)
    assert blocked.status_code == 429


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
