"""v5.4.1 — товары без реального фото: в конец выдачи (каталог/поиск), и вовсе
не на главной (feed + «Для вас»). Плейсхолдер считается «без фото» так же, как
пустая галерея (см. app.services.image_groups.has_real_photo)."""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User
from app.services.recommendations import recommend
from tests.conftest import make_product

NO_PHOTO = dict(image=None, images=[])
PLACEHOLDER = dict(image="/assets/placeholders/smartphones.svg", images=[])


@pytest.fixture()
def client(db):
    def override_db():
        yield db

    def override_user():
        u = db.query(User).first()
        if u is None:
            u = User(telegram_id=1)
            db.add(u)
            db.commit()
            db.refresh(u)
        return u

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# ---------------- /catalog/list: без фото — в конец, не пропадают ----------------

def test_list_sorts_no_photo_last_regardless_of_sort(client, db):
    # без фото, но с максимальной популярностью — по умолчанию встал бы первым
    make_product(db, title="Товар Икс без фото", popularity=1000, sku="NOPHOTO1", **NO_PHOTO)
    make_product(db, title="Товар Игрек с фото", popularity=1, sku="HASPHOTO1")

    r = client.get("/api/catalog/list")
    ids_order = [c["title"] for c in r.json()["cards"]]
    assert ids_order == ["Товар Игрек с фото", "Товар Икс без фото"]


def test_list_no_photo_not_dropped_just_deprioritized(client, db):
    make_product(db, title="Без фото", sku="NP2", **NO_PHOTO)
    r = client.get("/api/catalog/list")
    titles = [c["title"] for c in r.json()["cards"]]
    assert "Без фото" in titles  # присутствует, просто не первым


def test_list_placeholder_treated_as_no_photo(client, db):
    make_product(db, title="Плейсхолдер", popularity=999, sku="PH1", **PLACEHOLDER)
    make_product(db, title="Реальное фото", popularity=1, sku="REAL1")
    order = [c["title"] for c in client.get("/api/catalog/list").json()["cards"]]
    assert order == ["Реальное фото", "Плейсхолдер"]


def test_list_price_sort_preserved_within_photo_group(client, db):
    make_product(db, title="Дорогой с фото", price=500, sku="P1")
    make_product(db, title="Дешёвый с фото", price=100, sku="P2")
    make_product(db, title="Дешёвый без фото", price=50, sku="P3", **NO_PHOTO)

    order = [c["title"] for c in client.get("/api/catalog/list?sort=price_asc").json()["cards"]]
    assert order == ["Дешёвый с фото", "Дорогой с фото", "Дешёвый без фото"]


# ---------------- /catalog/search: то же самое ----------------

def test_search_sorts_no_photo_last(client, db):
    # слово не должно попасть в алиасы _SEARCH_ALIASES, иначе title его не содержит
    make_product(db, title="Модельикс без фото", popularity=1000, sku="S1", **NO_PHOTO)
    make_product(db, title="Модельикс с фото", popularity=1, sku="S2")

    r = client.get("/api/catalog/search", params={"query": "Модельикс"})
    titles = [c["title"] for c in r.json()["cards"]]
    assert titles == ["Модельикс с фото", "Модельикс без фото"]


# ---------------- /catalog/feed: без фото — совсем НЕ на главной ----------------

def test_feed_excludes_no_photo_from_hot(client, db):
    make_product(db, title="Хит без фото", is_hot=True, popularity=999, sku="H1", **NO_PHOTO)
    make_product(db, title="Хит с фото", is_hot=True, popularity=1, sku="H2")
    data = client.get("/api/catalog/feed").json()
    titles = [c["title"] for c in data["hot"]]
    assert "Хит без фото" not in titles
    assert "Хит с фото" in titles


def test_feed_excludes_no_photo_from_available_today(client, db):
    make_product(db, title="Сегодня без фото", is_available_today=True, in_stock=True,
                 popularity=999, sku="T1", **NO_PHOTO)
    make_product(db, title="Сегодня с фото", is_available_today=True, in_stock=True,
                 popularity=1, sku="T2")
    data = client.get("/api/catalog/feed").json()
    titles = [c["title"] for c in data["available_today"]]
    assert "Сегодня без фото" not in titles
    assert "Сегодня с фото" in titles


def test_feed_excludes_no_photo_from_new(client, db):
    make_product(db, title="Новинка без фото", is_new=True, sku="N1", **NO_PHOTO)
    make_product(db, title="Новинка с фото", is_new=True, sku="N2")
    data = client.get("/api/catalog/feed").json()
    titles = [c["title"] for c in data["new"]]
    assert "Новинка без фото" not in titles
    assert "Новинка с фото" in titles


def test_feed_excludes_no_photo_from_recommended(client, db):
    for i in range(10):
        make_product(db, title=f"Без фото {i}", popularity=100 - i, sku=f"R{i}", **NO_PHOTO)
    make_product(db, title="С фото", popularity=1, sku="RHAS")
    data = client.get("/api/catalog/feed").json()
    titles = [c["title"] for c in data["recommended"]]
    assert all("Без фото" not in t for t in titles)


def test_feed_placeholder_excluded_too(client, db):
    make_product(db, title="Хит-плейсхолдер", is_hot=True, popularity=999, sku="PHH", **PLACEHOLDER)
    make_product(db, title="Хит реальный", is_hot=True, popularity=1, sku="PHH2")
    data = client.get("/api/catalog/feed").json()
    titles = [c["title"] for c in data["hot"]]
    assert "Хит-плейсхолдер" not in titles


def test_feed_sections_still_populated_when_photos_exist(client, db):
    """Регрессия: секции не должны опустевать, когда фото есть у большинства."""
    for i in range(12):
        make_product(db, title=f"Товар {i}", popularity=i, sku=f"OK{i}",
                     is_hot=(i % 4 == 0), is_new=(i % 5 == 0))
    data = client.get("/api/catalog/feed").json()
    assert set(data) == {"hot", "available_today", "new", "recommended"}
    assert len(data["recommended"]) >= 1


# ---------------- «Для вас» (recommend()) на главной ----------------

def test_recommend_excludes_no_photo(db):
    make_product(db, title="Без фото популярный", popularity=1000, sku="RN1", **NO_PHOTO)
    make_product(db, title="С фото", popularity=1, sku="RN2")
    recs, _, _ = recommend(db, user_id=1, limit=8)
    assert "Без фото популярный" not in [p.title for p in recs]
    assert "С фото" in [p.title for p in recs]
