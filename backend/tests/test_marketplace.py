"""Изоляция «Маркетплейса»: пользовательские товары не смешиваются с обычным
каталогом (см. docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md)."""
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.product import Product
from app.models.user import User
from app.services.marketplace import MARKETPLACE_SOURCE, exclude_marketplace
from tests.conftest import make_product


def _client(db):
    def override_db():
        yield db

    def override_user():
        u = db.query(User).first()
        if u is None:
            u = User(telegram_id=701)
            db.add(u); db.commit(); db.refresh(u)
        return u

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    return TestClient(app)


def test_exclude_marketplace_filters_by_source(db):
    regular = make_product(db, title="Обычный", source="manual")
    listed = make_product(db, title="С маркетплейса", source=MARKETPLACE_SOURCE)
    stmt = exclude_marketplace(select(Product))
    ids = {p.id for p in db.execute(stmt).scalars().all()}
    assert regular.id in ids
    assert listed.id not in ids


def test_exclude_marketplace_does_not_touch_used_condition_without_source(db):
    """condition="used" сам по себе НЕ маркетплейс — источник изоляции ТОЛЬКО source."""
    own_used_stock = make_product(db, title="Свой б/у", source="manual", condition="used")
    stmt = exclude_marketplace(select(Product))
    ids = {p.id for p in db.execute(stmt).scalars().all()}
    assert own_used_stock.id in ids


def test_exclude_marketplace_does_not_exclude_null_source(db):
    """source=NULL (from raw-SQL или legacy paths) НЕ маркетплейс — only MARKETPLACE_SOURCE excluded."""
    null_source = make_product(db, title="Без источника", source=None)
    stmt = exclude_marketplace(select(Product))
    ids = {p.id for p in db.execute(stmt).scalars().all()}
    assert null_source.id in ids


def test_catalog_list_excludes_marketplace(db):
    make_product(db, title="Обычный смартфон", category="смартфоны", source="manual")
    make_product(db, title="Маркетплейс смартфон", category="смартфоны", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/list?category=смартфоны")
    titles = [c["title"] for c in r.json()["cards"]]
    assert "Обычный смартфон" in titles
    assert "Маркетплейс смартфон" not in titles
    app.dependency_overrides.clear()


def test_catalog_search_excludes_marketplace(db):
    make_product(db, title="iPhone 15 обычный", source="manual")
    make_product(db, title="iPhone 15 маркетплейс", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/search?query=iphone")
    titles = [c["title"] for c in r.json()["cards"]]
    assert "iPhone 15 обычный" in titles
    assert "iPhone 15 маркетплейс" not in titles
    app.dependency_overrides.clear()


def test_catalog_brands_excludes_marketplace(db):
    make_product(db, brand="Никогда-не-бренд", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/brands")
    assert "Никогда-не-бренд" not in r.json()["brands"]
    app.dependency_overrides.clear()


def test_catalog_feed_excludes_marketplace(db):
    make_product(db, title="Хит с маркетплейса", source=MARKETPLACE_SOURCE, is_hot=True)
    client = _client(db)
    r = client.get("/api/catalog/feed")
    titles = [c["title"] for c in r.json()["hot"]]
    assert "Хит с маркетплейса" not in titles
    app.dependency_overrides.clear()
