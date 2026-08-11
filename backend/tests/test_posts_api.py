"""API редакционных постов: создание, правка, публикация, правка после публикации.

Публикация постов и подтверждение сюда не входят просто так — сама by-default
модель постов (ChannelPost) общая с прайс/инфо-постами, но эти тесты бьют
только по /admin/posts (backend/app/api/posts.py).
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.main import app


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_admin] = lambda: "admin:test"
    yield TestClient(app)
    app.dependency_overrides.clear()


def _create_and_publish(client, monkeypatch, **overrides):
    from app.services import telegram_publisher

    monkeypatch.setattr(telegram_publisher.settings, "TELEGRAM_CHANNEL_ID", "-100123", raising=False)
    monkeypatch.setattr(telegram_publisher.settings, "TELEGRAM_BOT_TOKEN", "test-token", raising=False)
    monkeypatch.setattr(telegram_publisher, "call", lambda method, payload: {"message_id": 555})

    payload = {"title": "T", "body": "B", "kind": "news", "sources": []}
    payload.update(overrides)
    post = client.post("/api/admin/posts", json=payload).json()
    client.post(f"/api/admin/posts/{post['id']}/approve")
    published = client.post(f"/api/admin/posts/{post['id']}/publish", json={"confirm": True})
    assert published.status_code == 200, published.text
    return published.json()


def test_published_post_edit_updates_channel_message(client, db, monkeypatch):
    from app.services import telegram_publisher

    post = _create_and_publish(client, monkeypatch)
    calls = []
    monkeypatch.setattr(
        telegram_publisher, "call",
        lambda method, payload: (calls.append((method, payload)), {"message_id": 555})[1],
    )

    resp = client.patch(f"/api/admin/posts/{post['id']}", json={"body": "Новый текст"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "published"
    assert calls[0][0] == "editMessageText"
    assert calls[0][1]["message_id"] == post["telegram_message_id"]


def test_published_post_with_photo_edits_caption(client, db, monkeypatch):
    from app.services import telegram_publisher

    post = _create_and_publish(client, monkeypatch, image_url="https://example.com/a.jpg")
    calls = []
    monkeypatch.setattr(
        telegram_publisher, "call",
        lambda method, payload: (calls.append((method, payload)), {"message_id": 555})[1],
    )

    resp = client.patch(f"/api/admin/posts/{post['id']}", json={"body": "Новый текст"})
    assert resp.status_code == 200, resp.text
    assert calls[0][0] == "editMessageCaption"


def test_published_post_edit_rejects_oversized_caption(client, db, monkeypatch):
    post = _create_and_publish(client, monkeypatch, image_url="https://example.com/a.jpg")
    resp = client.patch(f"/api/admin/posts/{post['id']}", json={"body": "x" * 1100})
    assert resp.status_code == 400
    # Отклонённая правка не должна была измениться в БД.
    from app.models.post import ChannelPost
    row = db.get(ChannelPost, post["id"])
    assert row.body == "B"


def test_list_excludes_price_and_info_posts(client, db):
    """/admin/posts — только редакционные посты, не прайс/инфо-контент канала.

    ChannelPost — общая модель для редакционных постов (эта вкладка) и
    прайс/инфо-постов канала (price_channel.py). Без фильтра по kind сюда
    протекает весь контент вкладок «Прайс канала» и «Посты канала».
    """
    from app.models.post import ChannelPost

    db.add(ChannelPost(title="Прайс", body="B", kind="price", slug="price-1", status="draft"))
    db.add(ChannelPost(title="Инфо", body="B", kind="info", slug="info-1", status="draft"))
    db.add(ChannelPost(title="Навигация", body="B", kind="price_nav", slug="price_nav", status="draft"))
    db.commit()

    editorial = client.post("/api/admin/posts", json={
        "title": "Новость", "body": "B", "kind": "news", "sources": [],
    }).json()

    resp = client.get("/api/admin/posts")
    assert resp.status_code == 200
    titles = [p["title"] for p in resp.json()["posts"]]
    assert titles == ["Новость"]
    assert resp.json()["posts"][0]["id"] == editorial["id"]


def test_draft_edit_still_resets_approval(client, db):
    """Неопубликованный пост — старое поведение: правка снимает одобрение."""
    post = client.post("/api/admin/posts", json={
        "title": "T", "body": "B", "kind": "news", "sources": [],
    }).json()
    client.post(f"/api/admin/posts/{post['id']}/approve")

    resp = client.patch(f"/api/admin/posts/{post['id']}", json={"body": "B2"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "draft"
    assert resp.json()["approved_version"] is None
