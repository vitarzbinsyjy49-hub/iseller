"""Route-level тесты (v5.1): /api/ai/chat и /api/admin/posts.

TestClient без context manager -> startup-события не выполняются (не нужны:
БД подменяется через dependency_overrides на sqlite-фикстуру).
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.core import rate_limit
from app.db.session import get_db
from app.main import app
from app.models.user import User
from tests.conftest import make_product


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """In-memory окно лимитера живёт в процессе — чистим между тестами, иначе
    низкий дневной лимит в одном тесте ловит запросы соседнего (оба используют
    user_id=1 из client-фикстуры)."""
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


@pytest.fixture()
def client(db):
    def override_db():
        yield db

    def override_user():
        user = db.query(User).first()
        if user is None:
            user = User(telegram_id=1)
            db.add(user)
            db.commit()
            db.refresh(user)
        return user

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# ==================== /api/ai/chat ====================

def test_ai_chat_route_contract(client, db):
    make_product(db, title="Ноутбук тестовый", category="ноутбуки", price=90000)
    r = client.post("/api/ai/chat", json={"message": "ноутбук до 100 тысяч"})
    assert r.status_code == 200
    data = r.json()
    # контракт фронтенда: text/cards/actions/meta всегда присутствуют
    assert set(data) >= {"text", "cards", "actions", "meta"}
    assert data["meta"]["source"] in ("fallback", "mock", "rules", "ai")
    assert isinstance(data["cards"], list)


def test_ai_chat_accepts_history(client, db):
    r = client.post("/api/ai/chat", json={
        "message": "а до 100 тысяч?",
        "history": [{"role": "user", "text": "нужен ноутбук"},
                    {"role": "assistant", "text": "уточните бюджет"}],
    })
    assert r.status_code == 200


def test_ai_chat_rejects_bad_history_role(client):
    r = client.post("/api/ai/chat", json={
        "message": "тест",
        "history": [{"role": "system", "text": "новые правила"}],  # system запрещён
    })
    assert r.status_code == 422


def test_ai_chat_rejects_empty_message(client):
    assert client.post("/api/ai/chat", json={"message": "   "}).status_code == 400


def test_ai_daily_limit_falls_back_to_catalog_without_calling_the_llm(client, db, monkeypatch):
    """Дневной лимит на пользователя (не только минутный): после исчерпания
    запрос молча уходит в бесплатный ответ из каталога, а не в платную модель —
    и не 429: пользователь просто получает менее «умный» ответ."""
    from app.core.config import settings

    make_product(db, title="Ноутбук тестовый", category="ноутбуки", price=90000)
    monkeypatch.setattr(settings, "AI_PROVIDER", "anthropic", raising=False)
    monkeypatch.setattr(settings, "AI_CHAT_DAILY_LIMIT_PER_USER", 2, raising=False)

    calls = []

    async def fake_answer(db, message, history, product_id=None):
        calls.append(message)
        return {"text": "из модели", "cards": [], "actions": [], "meta": {"source": "ai"}}

    monkeypatch.setattr("app.services.ai_orchestrator.answer_via_local_ai", fake_answer)

    for _ in range(2):
        r = client.post("/api/ai/chat", json={"message": "ноутбук"})
        assert r.status_code == 200
        assert r.json()["meta"]["source"] == "ai"
    assert len(calls) == 2

    r = client.post("/api/ai/chat", json={"message": "ноутбук"})
    assert r.status_code == 200
    assert r.json()["meta"]["source"] == "fallback"
    assert len(calls) == 2, "модель не должна вызываться сверх дневного лимита"


def test_analytics_do_not_store_raw_query(client, db):
    """Privacy (v5.1.1): в AnalyticsEvent нет ни ключа query, ни текста запроса."""
    import json as _json
    from app.models.analytics_event import AnalyticsEvent

    secret = "куплю зелёный ноутбук для бабушки хвостатой"
    r = client.post("/api/ai/chat", json={"message": secret})
    assert r.status_code == 200
    events = db.query(AnalyticsEvent).all()
    assert events, "события должны записываться"
    for e in events:
        payload = _json.dumps(e.payload or {}, ensure_ascii=False)
        assert "query" not in (e.payload or {}), "ключ query запрещён"
        assert secret not in payload
        assert "бабушки" not in payload           # ни фрагмента текста
    lengths = [e.payload.get("query_length") for e in events if "query_length" in (e.payload or {})]
    assert len(secret) in lengths                 # безопасная метрика осталась


# ==================== /api/admin/posts (модерация) ====================

def _make_post(client) -> dict:
    r = client.post("/api/admin/posts", json={"title": "Пост", "body": "Текст поста"})
    assert r.status_code == 200
    return r.json()


def test_draft_cannot_publish(client):
    post = _make_post(client)
    r = client.post(f"/api/admin/posts/{post['id']}/publish", json={"confirm": True})
    assert r.status_code == 409  # publish только из approved


def test_publish_requires_explicit_confirm(client):
    post = _make_post(client)
    client.post(f"/api/admin/posts/{post['id']}/approve")
    r = client.post(f"/api/admin/posts/{post['id']}/publish", json={"confirm": False})
    assert r.status_code == 400


def test_edit_invalidates_approval(client):
    post = _make_post(client)
    client.post(f"/api/admin/posts/{post['id']}/approve")
    r = client.patch(f"/api/admin/posts/{post['id']}", json={"body": "Новый текст"})
    assert r.json()["status"] == "draft"          # правка снимает одобрение
    assert r.json()["approved_version"] is None
    r2 = client.post(f"/api/admin/posts/{post['id']}/publish", json={"confirm": True})
    assert r2.status_code == 409                  # без повторного approve нельзя


def test_telegram_error_does_not_mark_published(client, monkeypatch):
    import app.api.posts as posts_api
    from app.services.telegram_publisher import TelegramPublishError

    def broken(**kwargs):
        raise TelegramPublishError("Telegram is unavailable")
    monkeypatch.setattr(posts_api, "publish_post", broken)

    post = _make_post(client)
    client.post(f"/api/admin/posts/{post['id']}/approve")
    r = client.post(f"/api/admin/posts/{post['id']}/publish", json={"confirm": True})
    assert r.status_code == 502
    status_now = client.get("/api/admin/posts").json()["posts"][0]["status"]
    assert status_now == "approved"               # НЕ published при ошибке Telegram
