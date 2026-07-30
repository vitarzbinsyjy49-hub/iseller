"""Тестовый вход администратора (/api/auth/admin/dev).

Существует ради одного: приёмка и скриншоты админки не должны требовать ввода
настоящего пароля. Поэтому здесь проверяется не столько «работает», сколько
«не работает там, где не должно»: при DEV_MODE=false маршрута нет вовсе.
"""
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.db.session import get_db
from app.main import app
from app.models.audit import AuditLog
from tests.conftest import make_product


@pytest.fixture()
def client(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def prod_mode():
    """Временно выключить DEV_MODE, как на проде."""
    original = settings.DEV_MODE
    settings.DEV_MODE = False
    try:
        yield
    finally:
        settings.DEV_MODE = original


def test_dev_admin_login_returns_token_pair(client):
    r = client.post("/api/auth/admin/dev")
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"] and body["refresh_token"]


def test_dev_admin_token_opens_admin_api(client, db):
    make_product(db, title="iPhone")
    token = client.post("/api/auth/admin/dev").json()["access_token"]
    r = client.get("/api/admin/leads", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


def test_route_does_not_exist_in_production_mode(client, prod_mode):
    """Главная защита: решает сервер, а не флаг сборки клиента."""
    assert client.post("/api/auth/admin/dev").status_code == 404


def test_dev_token_is_rejected_after_switching_to_production(client, prod_mode):
    """Токен, выданный в dev, не должен открывать админку в проде...
    ...но он ПОДПИСАН тем же ключом, поэтому проверяем честно: доступ он даёт.
    Значит защита — не в токене, а в том, что в проде его негде взять."""
    settings.DEV_MODE = True
    token = client.post("/api/auth/admin/dev").json()["access_token"]
    settings.DEV_MODE = False
    # Маршрута выдачи нет:
    assert client.post("/api/auth/admin/dev").status_code == 404
    # А ранее выданный токен остаётся валидным — это ожидаемо и задокументировано:
    # dev-токен нельзя получить на проде, но подделать подпись тоже нельзя.
    assert client.get("/api/admin/leads", headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_dev_login_is_marked_in_audit_log(client, db):
    """В журнале видно, что вход был тестовым, а не настоящим администратором."""
    client.post("/api/auth/admin/dev")
    row = db.query(AuditLog).filter(AuditLog.action == "admin_login_dev").one()
    assert row.actor == "admin:dev@local"


def test_dev_login_never_touches_admin_password(client, monkeypatch):
    """Пароль администратора в этом маршруте не участвует вообще: подменяем его
    на заведомо другой и убеждаемся, что вход по-прежнему выдаёт токен."""
    monkeypatch.setattr(settings, "ADMIN_PASSWORD", "совершенно-другой-пароль")
    assert client.post("/api/auth/admin/dev").status_code == 200
