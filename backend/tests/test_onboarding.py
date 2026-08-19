"""Сторис-онбординг при первом входе: onboarding_seen_at на пользователе.

NULL = ещё не видел — единственное состояние, которым покрыты и новые, и уже
существующие пользователи (см. app/api/users.py: mark_onboarding_seen).
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User


@pytest.fixture()
def ctx(db):
    user = User(telegram_id=901, first_name="Оля", username="olya")
    other = User(telegram_id=902, first_name="Сосед", username="neighbour")
    db.add_all([user, other])
    db.commit()
    db.refresh(user)
    db.refresh(other)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    try:
        yield TestClient(app), db, user, other
    finally:
        app.dependency_overrides.clear()


def test_fresh_user_has_not_seen_onboarding(ctx):
    client, _db, _user, _other = ctx
    data = client.get("/api/users/me").json()
    assert data["onboarding_seen_at"] is None


def test_marking_seen_sets_timestamp(ctx):
    client, db, user, _other = ctx
    data = client.post("/api/users/onboarding-seen").json()
    assert data["onboarding_seen_at"] is not None

    db.refresh(user)
    assert user.onboarding_seen_at is not None


def test_marking_seen_twice_is_idempotent(ctx):
    """Гонка между «закрыть» и естественным завершением последнего слайда не
    должна двигать уже проставленную метку."""
    client, _db, _user, _other = ctx
    first = client.post("/api/users/onboarding-seen").json()
    second = client.post("/api/users/onboarding-seen").json()
    assert first["onboarding_seen_at"] == second["onboarding_seen_at"]


def test_marking_seen_does_not_affect_other_users(ctx):
    client, db, _user, other = ctx
    client.post("/api/users/onboarding-seen")
    db.refresh(other)
    assert other.onboarding_seen_at is None
