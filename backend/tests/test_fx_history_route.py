"""GET /api/fx/history — без авторизации, отдаёт историю курса для графика в шторке."""
from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.db.session import get_db
from app.main import app
from app.models.fx_rate import FxRateHistory


def _client(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    return TestClient(app)


def test_history_route_empty_without_data(db):
    client = _client(db)
    try:
        r = client.get("/api/fx/history?days=30")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200
    assert r.json() == {"history": []}


def test_history_route_respects_days_param(db):
    base = date.today() - timedelta(days=5)
    for i in range(5):
        db.add(FxRateHistory(date=base + timedelta(days=i), value=90 + i))
    db.commit()

    client = _client(db)
    try:
        r = client.get("/api/fx/history?days=2")
    finally:
        app.dependency_overrides.clear()

    body = r.json()["history"]
    assert len(body) == 2
    assert body[-1]["value"] == 94


def test_history_route_requires_no_auth(db):
    """Публичный рыночный курс — без токена всё равно 200, а не 401."""
    client = _client(db)
    try:
        r = client.get("/api/fx/history?days=30")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200
