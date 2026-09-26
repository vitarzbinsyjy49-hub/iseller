"""«Сообщить об ошибке» — уровень HTTP: ручка, квоты, вкладка админки."""
import io

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.core import rate_limit
from app.db.session import get_db
from app.main import app
from app.models.bug_report import BugReport
from app.models.user import User


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=603, first_name="Ира", username="ira")
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


def _shot() -> dict:
    return {"file": ("shot.png", io.BytesIO(b"\x89PNG" + b"0" * 100), "image/png")}


def test_user_sends_report_and_owner_closes_it(ctx):
    client, db, u = ctx
    url = client.post("/api/bug-reports/photo", files=_shot()).json()["url"]
    resp = client.post("/api/bug-reports", json={
        "text": "Корзина пустая после перезахода", "photos": [url],
        "context": {"platform": "android", "path": "/cart"},
    })
    assert resp.status_code == 201

    listed = client.get("/api/admin/bug-reports?status_filter=new").json()
    assert listed["new"] == 1
    report = listed["reports"][0]
    assert report["text"] == "Корзина пустая после перезахода"
    assert report["photos"] == [url] and report["username"] == "ira"

    closed = client.patch(f"/api/admin/bug-reports/{report['id']}", json={"status": "fixed"})
    assert closed.status_code == 200 and closed.json()["status"] == "fixed"
    assert client.get("/api/admin/bug-reports").json()["new"] == 0


def test_short_text_is_422(ctx):
    client, db, _u = ctx
    assert client.post("/api/bug-reports", json={"text": "ой"}).status_code == 422
    assert db.query(BugReport).count() == 0


def test_reports_are_rate_limited(ctx, monkeypatch):
    """Каждое сообщение — алерт владельцу в личку: без потолка это спам."""
    client, _db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.BUG_REPORT_DAILY_LIMIT_PER_USER", 1)
    assert client.post("/api/bug-reports", json={"text": "Не грузится главная"}).status_code == 201
    assert client.post("/api/bug-reports", json={"text": "Не грузится главная"}).status_code == 429


def test_screenshot_upload_rejects_non_images_and_is_rate_limited(ctx, monkeypatch):
    client, _db, _u = ctx
    bad = {"file": ("x.txt", io.BytesIO(b"hello"), "text/plain")}
    assert client.post("/api/bug-reports/photo", files=bad).status_code == 400
    rate_limit._hits.clear()  # отказ по типу тоже тратит квоту — как у отзывов
    monkeypatch.setattr("app.core.config.settings.BUG_REPORT_PHOTO_DAILY_LIMIT_PER_USER", 1)
    assert client.post("/api/bug-reports/photo", files=_shot()).status_code == 201
    assert client.post("/api/bug-reports/photo", files=_shot()).status_code == 429


def test_unknown_status_is_422(ctx):
    client, db, u = ctx
    client.post("/api/bug-reports", json={"text": "Не работает поиск"})
    rid = db.query(BugReport).one().id
    assert client.patch(f"/api/admin/bug-reports/{rid}", json={"status": "done"}).status_code == 422
