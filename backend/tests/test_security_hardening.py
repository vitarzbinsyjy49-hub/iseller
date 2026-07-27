"""Security hardening (v5.4.2).

1) Swagger/OpenAPI публикуются только в DEV_MODE — на проде схема API закрыта.
2) Админ-логин: constant-time сравнение пароля + rate limit на перебор.
"""
import importlib

import pytest
from fastapi.testclient import TestClient

from app.core import rate_limit
from app.core.config import settings
from app.db.session import get_db
from app.main import app


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """In-memory окно лимитера живёт в процессе — чистим, чтобы тесты не влияли
    друг на друга (иначе исчерпанный в одном тесте лимит ломает соседний)."""
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


@pytest.fixture()
def client(db):
    def override_db():
        yield db
    app.dependency_overrides[get_db] = override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# ---------------- docs exposure ----------------

def _build_app(dev_mode: bool):
    """Пересобрать приложение с нужным DEV_MODE (модуль читает флаг на импорте).

    DEV_MODE=false также включает CORS-guard, требующий непустой ALLOWED_ORIGINS —
    задаём его, как на реальном проде, иначе упадёт на другой (ожидаемой) проверке."""
    original_dev, original_origins = settings.DEV_MODE, settings.ALLOWED_ORIGINS
    settings.DEV_MODE = dev_mode
    if not dev_mode and not settings.ALLOWED_ORIGINS:
        settings.ALLOWED_ORIGINS = "https://example.test"
    try:
        import app.main as main_module
        importlib.reload(main_module)
        return main_module.app
    finally:
        settings.DEV_MODE, settings.ALLOWED_ORIGINS = original_dev, original_origins
        import app.main as main_module
        importlib.reload(main_module)


def test_docs_hidden_when_dev_mode_off():
    prod_app = _build_app(dev_mode=False)
    assert prod_app.docs_url is None
    assert prod_app.openapi_url is None
    assert prod_app.redoc_url is None


def test_docs_available_in_dev_mode():
    dev_app = _build_app(dev_mode=True)
    assert dev_app.docs_url == "/api/docs"
    assert dev_app.openapi_url == "/api/openapi.json"


# ---------------- admin login hardening ----------------

def test_admin_login_rejects_wrong_password(client):
    r = client.post("/api/auth/admin/login",
                    json={"email": settings.ADMIN_EMAIL, "password": "definitely-wrong"})
    assert r.status_code == 401


def test_admin_login_accepts_correct_password(client):
    r = client.post("/api/auth/admin/login",
                    json={"email": settings.ADMIN_EMAIL, "password": settings.ADMIN_PASSWORD})
    assert r.status_code == 200
    assert r.json()["access_token"]


def test_admin_login_rate_limited_after_repeated_failures(client):
    """Перебор пароля должен упираться в 429, а не крутиться бесконечно."""
    codes = []
    for _ in range(settings.ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE + 3):
        r = client.post("/api/auth/admin/login",
                        json={"email": settings.ADMIN_EMAIL, "password": "wrong"})
        codes.append(r.status_code)
    assert 429 in codes, f"ожидали 429 после серии неудач, получили {codes}"


def test_rate_limit_blocks_even_correct_password_after_burst(client):
    """Ключевое свойство: лимит не обходится подстановкой верного пароля."""
    for _ in range(settings.ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE + 1):
        client.post("/api/auth/admin/login",
                    json={"email": settings.ADMIN_EMAIL, "password": "wrong"})
    r = client.post("/api/auth/admin/login",
                    json={"email": settings.ADMIN_EMAIL, "password": settings.ADMIN_PASSWORD})
    assert r.status_code == 429
