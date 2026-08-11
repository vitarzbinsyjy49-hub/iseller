"""«Популярные» в каталоге (GET /catalog/list, sort=popularity по умолчанию).

Спрос сейчас сконцентрирован в смартфонах — их и просматривают чаще, и их
физически больше в каталоге. Без диверсификации «Популярное» вырождалось бы
в «сначала все смартфоны, потом остальное», хотя фактически спрос есть и на
другие категории. См. services/ranking.view_counts + рекомендации в
services/recommendations.diversify_by_category (тот же приём, что и у
секции «Для вас» на главной).
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User
from tests.conftest import make_product


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


def _seed_skewed_catalog(db):
    """8 смартфонов с высокой популярностью, по 2 товара в трёх других категориях
    с низкой — ровно ситуация «спрос сконцентрирован в одной категории»."""
    for i in range(8):
        make_product(db, title=f"Phone {i}", category="смартфоны", popularity=50 - i)
    for i in range(2):
        make_product(db, title=f"Console {i}", category="консоли", popularity=5 - i)
    for i in range(2):
        make_product(db, title=f"Vacuum {i}", category="красота", popularity=5 - i)
    for i in range(2):
        make_product(db, title=f"Laptop {i}", category="ноутбуки", popularity=5 - i)


def test_popularity_sort_mixes_categories_without_filters(client, db):
    _seed_skewed_catalog(db)
    r = client.get("/api/catalog/list", params={"limit": 8})
    assert r.status_code == 200
    cards = r.json()["cards"]
    cats = [c["category"] for c in cards]
    assert cats.count("смартфоны") < len(cats)   # не только смартфоны
    assert len(set(cats)) >= 3                     # минимум 3 разные категории в топе


def test_category_filter_is_not_diversified(client, db):
    """Явный фильтр категории — намерение увидеть именно её, диверсификация
    здесь означала бы теряющий товары шум, а не помощь."""
    _seed_skewed_catalog(db)
    r = client.get("/api/catalog/list", params={"category": "смартфоны", "limit": 8})
    assert r.status_code == 200
    cats = {c["category"] for c in r.json()["cards"]}
    assert cats == {"смартфоны"}


def test_price_sort_is_not_diversified(client, db):
    """Явная сортировка по цене — по-прежнему чистый порядок цены, без
    перемешивания категорий."""
    _seed_skewed_catalog(db)
    r = client.get("/api/catalog/list", params={"sort": "price_desc", "limit": 3})
    assert r.status_code == 200
    prices = [c["price"] for c in r.json()["cards"]]
    assert prices == sorted(prices, reverse=True)
