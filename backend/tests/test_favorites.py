"""Тесты серверного избранного (/api/favorites).

Покрывают требования pre-launch: идемпотентность, изоляция по пользователю,
404 на несуществующий товар, показ «нет в наличии» но скрытие снятых с
публикации, merge локального избранного без затирания серверного.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.favorite import ProductFavorite
from app.models.user import User
from tests.conftest import make_product


@pytest.fixture()
def ctx(db):
    """TestClient + два пользователя; текущего переключаем через holder['uid']."""
    u1 = User(telegram_id=101, first_name="U1")
    u2 = User(telegram_id=202, first_name="U2")
    db.add_all([u1, u2])
    db.commit()
    db.refresh(u1)
    db.refresh(u2)
    holder = {"uid": u1.id}

    def override_db():
        yield db

    def override_user():
        return db.get(User, holder["uid"])

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    try:
        yield TestClient(app), db, holder, u1, u2
    finally:
        app.dependency_overrides.clear()


def test_add_list_remove_favorite(ctx):
    client, db, _holder, _u1, _u2 = ctx
    p = make_product(db, title="iPhone")
    assert client.get("/api/favorites/ids").json()["ids"] == []

    r = client.put(f"/api/favorites/{p.id}")
    assert r.status_code == 200 and r.json()["favorited"] is True
    assert client.get("/api/favorites/ids").json()["ids"] == [p.id]

    cards = client.get("/api/favorites").json()["cards"]
    assert len(cards) == 1 and cards[0]["id"] == p.id

    assert client.delete(f"/api/favorites/{p.id}").json()["favorited"] is False
    assert client.get("/api/favorites/ids").json()["ids"] == []


def test_add_is_idempotent(ctx):
    client, db, *_ = ctx
    p = make_product(db)
    client.put(f"/api/favorites/{p.id}")
    client.put(f"/api/favorites/{p.id}")  # повтор не создаёт дубль
    assert client.get("/api/favorites/ids").json()["ids"] == [p.id]
    assert db.query(ProductFavorite).count() == 1


def test_remove_is_idempotent(ctx):
    client, db, *_ = ctx
    p = make_product(db)
    r = client.delete(f"/api/favorites/{p.id}")  # не было в избранном
    assert r.status_code == 200 and r.json()["favorited"] is False


def test_add_nonexistent_product_returns_404(ctx):
    client, *_ = ctx
    assert client.put("/api/favorites/999999").status_code == 404


def test_favorites_isolated_per_user(ctx):
    client, db, holder, u1, u2 = ctx
    p = make_product(db)
    holder["uid"] = u1.id
    client.put(f"/api/favorites/{p.id}")
    holder["uid"] = u2.id
    assert client.get("/api/favorites/ids").json()["ids"] == []
    assert client.get("/api/favorites").json()["cards"] == []


def test_list_shows_out_of_stock_but_hides_inactive(ctx):
    client, db, *_ = ctx
    oos = make_product(db, title="Нет в наличии", in_stock=False, stock=0, is_active=True)
    hidden = make_product(db, title="Скрыт админом", is_active=False)
    client.put(f"/api/favorites/{oos.id}")
    client.put(f"/api/favorites/{hidden.id}")

    ids = client.get("/api/favorites/ids").json()["ids"]
    assert set(ids) == {oos.id, hidden.id}  # сердечко консистентно для обоих

    cards = client.get("/api/favorites").json()["cards"]
    assert [c["id"] for c in cards] == [oos.id]  # нет в наличии показан, скрытый — нет
    assert cards[0]["in_stock"] is False


def test_merge_adds_local_without_wiping_server(ctx):
    client, db, *_ = ctx
    p1 = make_product(db, title="A")
    p2 = make_product(db, title="B")
    p3 = make_product(db, title="C")
    client.put(f"/api/favorites/{p1.id}")  # серверное уже есть
    r = client.post("/api/favorites/merge", json={"ids": [p2.id, p3.id, 999999]})
    assert set(r.json()["ids"]) == {p1.id, p2.id, p3.id}  # p1 сохранён, несуществующий отброшен


def test_merge_empty_local_keeps_server(ctx):
    client, db, *_ = ctx
    p1 = make_product(db)
    client.put(f"/api/favorites/{p1.id}")
    assert client.post("/api/favorites/merge", json={"ids": []}).json()["ids"] == [p1.id]
    assert client.post("/api/favorites/merge", json={}).json()["ids"] == [p1.id]
