"""v5.4.2 — одноразовые refresh-токены (ротация + отзыв по jti).

Украденный refresh-токен должен работать максимум один раз, а не все
REFRESH_TOKEN_DAYS. Токены, выданные до появления jti, принимаются один раз
(чтобы не разлогинить живых пользователей) и меняются на новые — уже с jti.
"""
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.security import create_refresh_token, decode_token_payload
from app.db.session import get_db
from app.main import app
from app.models.revoked_token import RevokedRefreshToken
from app.services.token_revocation import purge_expired


@pytest.fixture()
def client(db):
    def override_db():
        yield db
    app.dependency_overrides[get_db] = override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _legacy_refresh_token(subject: str) -> str:
    """Как выглядели refresh-токены до v5.4.2 — без jti."""
    now = datetime.now(timezone.utc)
    payload = {"sub": subject, "type": "refresh", "iat": now,
               "exp": now + timedelta(days=settings.REFRESH_TOKEN_DAYS)}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm="HS256")


# ---------------- выдача ----------------

def test_refresh_token_has_unique_jti():
    a = decode_token_payload(create_refresh_token("user:1"), "refresh")
    b = decode_token_payload(create_refresh_token("user:1"), "refresh")
    assert a["jti"] and b["jti"]
    assert a["jti"] != b["jti"]


# ---------------- нормальная ротация ----------------

def test_refresh_returns_new_pair(client):
    token = create_refresh_token("user:1")
    r = client.post("/api/auth/refresh", json={"refresh_token": token})
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"] and body["refresh_token"]
    assert body["refresh_token"] != token           # выдан НОВЫЙ refresh


def test_rotated_token_works_and_old_one_dies(client):
    first = create_refresh_token("user:7")
    second = client.post("/api/auth/refresh", json={"refresh_token": first}).json()["refresh_token"]

    # новый — рабочий
    assert client.post("/api/auth/refresh", json={"refresh_token": second}).status_code == 200
    # старый — уже нет
    assert client.post("/api/auth/refresh", json={"refresh_token": first}).status_code == 401


# ---------------- защита от повторного использования ----------------

def test_reuse_of_same_refresh_token_rejected(client):
    token = create_refresh_token("user:2")
    assert client.post("/api/auth/refresh", json={"refresh_token": token}).status_code == 200
    r2 = client.post("/api/auth/refresh", json={"refresh_token": token})
    assert r2.status_code == 401, "повторное использование refresh-токена должно отклоняться"


def test_revocation_recorded_in_db(client, db):
    token = create_refresh_token("user:3")
    jti = decode_token_payload(token, "refresh")["jti"]
    client.post("/api/auth/refresh", json={"refresh_token": token})
    row = db.query(RevokedRefreshToken).filter_by(jti=jti).one_or_none()
    assert row is not None and row.subject == "user:3"


def test_subject_preserved_across_rotation(client):
    token = create_refresh_token("admin:admin@test.local")
    new_refresh = client.post("/api/auth/refresh", json={"refresh_token": token}).json()["refresh_token"]
    assert decode_token_payload(new_refresh, "refresh")["sub"] == "admin:admin@test.local"


# ---------------- обратная совместимость ----------------

def test_legacy_token_without_jti_still_accepted_once(client):
    """Живые пользователи со старыми токенами не должны быть разлогинены."""
    legacy = _legacy_refresh_token("user:9")
    r = client.post("/api/auth/refresh", json={"refresh_token": legacy})
    assert r.status_code == 200
    # и получают уже нормальный токен с jti
    assert decode_token_payload(r.json()["refresh_token"], "refresh")["jti"]


# ---------------- прочие проверки ----------------

def test_garbage_and_wrong_type_rejected(client):
    assert client.post("/api/auth/refresh", json={"refresh_token": "not-a-jwt"}).status_code == 401
    from app.core.security import create_access_token
    access = create_access_token("user:1")
    assert client.post("/api/auth/refresh", json={"refresh_token": access}).status_code == 401


def test_purge_removes_only_expired(db):
    now = datetime.now(timezone.utc)
    db.add(RevokedRefreshToken(jti="old", subject="user:1", expires_at=now - timedelta(days=1)))
    db.add(RevokedRefreshToken(jti="fresh", subject="user:1", expires_at=now + timedelta(days=1)))
    db.commit()
    purge_expired(db)
    left = {r.jti for r in db.query(RevokedRefreshToken).all()}
    assert left == {"fresh"}
