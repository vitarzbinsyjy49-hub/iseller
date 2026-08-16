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
    make_product(db, brand="Обычный-бренд-регрессия", source="manual")
    make_product(db, brand="Никогда-не-бренд", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/brands")
    brands_list = r.json()["brands"]
    assert "Обычный-бренд-регрессия" in brands_list
    assert "Никогда-не-бренд" not in brands_list
    app.dependency_overrides.clear()


def test_catalog_feed_excludes_marketplace(db):
    make_product(db, title="Хит обычный", source="manual", is_hot=True)
    make_product(db, title="Хит с маркетплейса", source=MARKETPLACE_SOURCE, is_hot=True)
    client = _client(db)
    r = client.get("/api/catalog/feed")
    titles = [c["title"] for c in r.json()["hot"]]
    assert "Хит обычный" in titles
    assert "Хит с маркетплейса" not in titles
    app.dependency_overrides.clear()


def test_marketplace_endpoint_returns_only_user_submitted(db):
    make_product(db, title="Обычный", source="manual")
    listed = make_product(db, title="С маркетплейса", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/marketplace")
    assert r.status_code == 200
    titles = [c["title"] for c in r.json()["cards"]]
    assert titles == ["С маркетплейса"]
    app.dependency_overrides.clear()


def test_marketplace_endpoint_deterministic_order(db):
    """Тот же принцип, что test_order_is_fully_deterministic у обычного каталога:
    id в конце ключа сортировки обязателен."""
    make_product(db, title="A", source=MARKETPLACE_SOURCE, price=1000)
    make_product(db, title="B", source=MARKETPLACE_SOURCE, price=1000)
    client = _client(db)
    r1 = client.get("/api/catalog/marketplace")
    r2 = client.get("/api/catalog/marketplace")
    assert [c["id"] for c in r1.json()["cards"]] == [c["id"] for c in r2.json()["cards"]]
    app.dependency_overrides.clear()


def test_ai_fallback_category_branch_excludes_marketplace(db):
    """Ветка «топ категории» в build_demo_answer — ПЕРВИЧНЫЙ путь ответа при
    AI_PROVIDER=fallback (значение по умолчанию), сюда же уходит короткое
    замыкание AI_SKIP_LLM_FOR_BROWSE и деградация оркестратора. Без исключения
    маркетплейса ИИ-консультант рекомендует чужой б/у товар как ассортимент."""
    from app.services.ai_provider import build_demo_answer

    make_product(db, title="Xiaomi 13", category="смартфоны", source="manual", price=30000)
    make_product(db, title="Redmi с рук", category="смартфоны",
                 source=MARKETPLACE_SOURCE, price=10000)
    # «телефон» есть в разговорном словаре (-> «смартфоны»), но не встречается
    # ни в одном названии — поэтому пословный поиск пуст и включается именно
    # ветка по категории.
    answer = build_demo_answer(db, "нужен телефон")
    assert answer["meta"]["category"] == "смартфоны"
    titles = [c["title"] for c in answer["cards"]]
    assert "Xiaomi 13" in titles
    assert "Redmi с рук" not in titles
