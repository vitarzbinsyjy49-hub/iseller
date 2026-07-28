"""Навигация по каталогу выводится из товаров (v5.8).

Регрессия, ради которой написаны эти тесты: список категорий был захардкожен в
коде и в сиде главной, разъехался с БД, и плитки «Dyson»/«Аксессуары» вели в
пустой каталог. Ни одного теста на /catalog/categories и /home не было — именно
поэтому баг дожил до прода. Здесь проверяется главное правило: плитка существует
тогда и только тогда, когда за ней есть товары.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.api.home import default_categories, seed_home_defaults
from app.db.session import get_db
from app.main import app
from app.models.home import ACTION_TYPES, HomeBanner, HomeCategory
from app.models.user import User
from app.services.catalog_nav import (
    BRAND_ICONS, FALLBACK_ICON, SALE_KEY, category_label, has_products,
    list_brands, list_categories, resolve_category,
)
from tests.conftest import make_product


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


def _keys(cats) -> list[str]:
    return [c["key"] for c in cats]


# ---------- список категорий = то, что реально лежит в каталоге ----------

def test_empty_catalog_has_no_categories(db):
    assert list_categories(db) == []


def test_only_categories_with_products(db):
    make_product(db, title="iPhone", category="смартфоны")
    make_product(db, title="MacBook", category="ноутбуки")
    assert set(_keys(list_categories(db))) == {"смартфоны", "ноутбуки"}


def test_new_category_appears_by_itself(db):
    """Ключевое требование: товар с новой категорией из админки — и она в меню.
    Ничего дописывать в код не нужно."""
    make_product(db, title="iPhone", category="смартфоны")
    assert "красота" not in _keys(list_categories(db))
    make_product(db, title="Dyson HD16", category="красота", brand="Dyson")
    assert "красота" in _keys(list_categories(db))


def test_category_disappears_when_last_product_deactivated(db):
    p = make_product(db, title="Dyson HD16", category="красота", brand="Dyson")
    assert "красота" in _keys(list_categories(db))
    p.is_active = False
    db.commit()
    assert "красота" not in _keys(list_categories(db))


def test_inactive_products_do_not_create_category(db):
    make_product(db, title="Скрытый", category="призрачная", is_active=False)
    assert _keys(list_categories(db)) == []


def test_counts_are_real(db):
    for i in range(3):
        make_product(db, title=f"iPhone {i}", category="смартфоны")
    make_product(db, title="MacBook", category="ноутбуки")
    counts = {c["key"]: c["count"] for c in list_categories(db)}
    assert counts == {"смартфоны": 3, "ноутбуки": 1}


def test_order_is_deterministic_biggest_first(db):
    make_product(db, title="A", category="ноутбуки")
    for i in range(3):
        make_product(db, title=f"B{i}", category="смартфоны")
    make_product(db, title="C", category="часы")
    assert _keys(list_categories(db))[:2] == ["смартфоны", "ноутбуки"]


# ---------- оформление незнакомой категории ----------

def test_unknown_category_gets_fallback_icon_and_label(db):
    make_product(db, title="Робот-пылесос", category="умный дом")
    cat = next(c for c in list_categories(db) if c["key"] == "умный дом")
    assert cat["icon"] == FALLBACK_ICON       # не падаем и не прячем
    assert cat["label"] == "Умный дом"        # подпись выводится из названия


@pytest.mark.parametrize("raw,expected", [
    ("бытовая техника", "Бытовая техника"),
    ("часы", "Часы"),
    ("iPhone аксессуары", "IPhone аксессуары"),
    ("", ""),
])
def test_label_capitalization(raw, expected):
    assert category_label(raw) == expected


# ---------- виртуальная категория «Скидки» ----------

def test_sale_absent_without_discounts(db):
    make_product(db, title="iPhone", category="смартфоны", on_sale=False)
    assert SALE_KEY not in _keys(list_categories(db))


def test_sale_appears_with_discounts(db):
    make_product(db, title="iPhone", category="смартфоны", on_sale=True)
    cats = list_categories(db)
    assert SALE_KEY in _keys(cats)
    assert next(c for c in cats if c["key"] == SALE_KEY)["count"] == 1


# ---------- бренды: та же ось навигации, тот же источник правды ----------

def test_empty_catalog_has_no_brands(db):
    assert list_brands(db) == []


def test_only_brands_with_active_products(db):
    make_product(db, brand="Apple")
    make_product(db, brand="Sony", category="консоли", is_active=False)
    assert [b["key"] for b in list_brands(db)] == ["Apple"]


def test_brands_order_biggest_first_then_name(db):
    make_product(db, brand="Dyson", category="красота")
    make_product(db, brand="Dyson", category="бытовая техника")
    make_product(db, brand="Apple")
    make_product(db, brand="Sony", category="консоли")
    # Dyson 2 товара -> первый; Apple и Sony по одному -> по алфавиту
    assert [b["key"] for b in list_brands(db)] == ["Dyson", "Apple", "Sony"]


def test_brand_key_keeps_original_case(db):
    make_product(db, brand="Dyson", category="красота")
    # ?brand= сравнивает точным равенством: нормализация ключа сломала бы переход
    assert list_brands(db)[0]["key"] == "Dyson"
    assert list_brands(db)[0]["label"] == "Dyson"


def test_known_brand_gets_its_icon(db):
    make_product(db, brand="Dyson", category="красота")
    assert list_brands(db)[0]["icon"] == BRAND_ICONS["dyson"]


def test_unknown_brand_gets_fallback_icon_but_stays_in_nav(db):
    make_product(db, brand="Zanussi", category="бытовая техника")
    brands = list_brands(db)
    assert [b["key"] for b in brands] == ["Zanussi"]
    assert brands[0]["icon"] == FALLBACK_ICON


def test_brand_counts_are_real(db):
    make_product(db, brand="Dyson", category="красота")
    make_product(db, brand="Dyson", category="бытовая техника")
    assert list_brands(db)[0]["count"] == 2


# ---------- правило видимости плитки ----------

def _ctx(categories=None, brands=None, sale=0):
    return {"categories": categories or {}, "brands": brands or {}, "sale": sale}


@pytest.mark.parametrize("atype,value,ctx,visible", [
    ("category", "смартфоны", _ctx(categories={"смартфоны": 5}), True),
    ("category", "dyson", _ctx(categories={"красота": 34}), False),   # тот самый баг
    ("category", "", _ctx(categories={"смартфоны": 5}), False),
    ("category", SALE_KEY, _ctx(sale=3), True),
    ("category", SALE_KEY, _ctx(sale=0), False),
    ("brand", "Dyson", _ctx(brands={"Dyson": 50}), True),
    ("brand", "Samsung", _ctx(brands={"Dyson": 50}), False),
    # посчитать нельзя => не скрываем: отсутствие ответа не значит пустоту
    ("search", "iPhone", _ctx(), True),
    ("collection", "hot", _ctx(), True),
    ("ai", "", _ctx(), True),
    ("external", "https://example.com", _ctx(), True),
])
def test_tile_visibility_rule(atype, value, ctx, visible):
    assert has_products(atype, value, **ctx) is visible


def test_brand_is_a_supported_action_type():
    """Dyson — бренд, а не категория; без этого типа плитку не сделать."""
    assert "brand" in ACTION_TYPES


# ---------- /home: мёртвые плитки не выходят наружу ----------

def test_home_hides_tile_without_products(client, db):
    make_product(db, title="Dyson HD16", category="красота", brand="Dyson")
    db.add_all([
        HomeCategory(title="Красота", emoji="💇", action_type="category",
                     action_value="красота", position=1),
        HomeCategory(title="Dyson", emoji="💨", action_type="category",
                     action_value="dyson", position=2),          # мёртвая ссылка
        HomeCategory(title="Аксессуары", emoji="🔌", action_type="category",
                     action_value="аксессуары", position=3),     # мёртвая ссылка
    ])
    db.commit()
    titles = [c["title"] for c in client.get("/api/home").json()["categories"]]
    assert titles == ["Красота"]


def test_home_adds_uncurated_category_automatically(client, db):
    """Новая категория (импорт/админка) появляется в навигации сама —
    без правок кода и без ручного создания плитки."""
    make_product(db, title="iPhone", category="смартфоны")
    make_product(db, title="Apple Watch Ultra", category="часы")
    db.add(HomeCategory(title="Смартфоны", emoji="📱", action_type="category",
                        action_value="смартфоны", position=1))
    db.commit()
    titles = [c["title"] for c in client.get("/api/home").json()["categories"]]
    assert titles == ["Смартфоны", "Часы"]      # «Часы» добавились сами


def test_home_respects_explicitly_disabled_tile(client, db):
    """Выключенная админом плитка не воскресает автодобавлением:
    is_active=False — осознанное «не показывать»."""
    make_product(db, title="Apple Watch Ultra", category="часы")
    db.add(HomeCategory(title="Часы", emoji="⌚", action_type="category",
                        action_value="часы", position=1, is_active=False))
    db.commit()
    assert client.get("/api/home").json()["categories"] == []


def test_home_does_not_duplicate_curated_category(client, db):
    make_product(db, title="iPhone", category="смартфоны")
    db.add(HomeCategory(title="Смартфоны (хит)", emoji="🔥", action_type="category",
                        action_value="смартфоны", position=1))
    db.commit()
    cats = client.get("/api/home").json()["categories"]
    assert [c["title"] for c in cats] == ["Смартфоны (хит)"]   # админская подпись сохранена


def test_home_keeps_brand_tile_when_brand_exists(client, db):
    make_product(db, title="Dyson HD16", category="красота", brand="Dyson")
    db.add_all([
        HomeCategory(title="Dyson", emoji="💨", action_type="brand",
                     action_value="Dyson", position=1),
        HomeCategory(title="Samsung", emoji="📱", action_type="brand",
                     action_value="Samsung", position=2),        # такого бренда нет
    ])
    db.commit()
    titles = [c["title"] for c in client.get("/api/home").json()["categories"]]
    assert titles[0] == "Dyson"          # бренд с товарами — первым, как задан админом
    assert "Samsung" not in titles       # бренда нет в каталоге -> плитки нет
    assert "Красота" in titles           # категория без плитки добавилась сама


def test_home_keeps_uncountable_tiles(client, db):
    """AI/поиск/подборка не про количество товаров — скрывать их нельзя."""
    make_product(db, title="iPhone", category="смартфоны")
    db.add_all([
        HomeCategory(title="Спросить AI", emoji="🤖", action_type="ai",
                     action_value="", position=1),
        HomeCategory(title="Забрать сегодня", emoji="⚡", action_type="collection",
                     action_value="today", position=2),
        HomeCategory(title="iPhone", emoji="📱", action_type="search",
                     action_value="iPhone", position=3),
    ])
    db.commit()
    titles = [c["title"] for c in client.get("/api/home").json()["categories"]]
    # Порядок админских плиток сохранён, ни одна не потеряна; «Смартфоны»
    # добавились сами — категории без плитки подтягиваются в хвост.
    assert titles[:3] == ["Спросить AI", "Забрать сегодня", "iPhone"]
    assert titles[3:] == ["Смартфоны"]


def test_categories_endpoint_has_no_dead_tiles(client, db):
    """Сквозная проверка контракта: каждая отданная плитка кликабельна —
    за ней есть товары, которые вернёт каталог."""
    make_product(db, title="iPhone", category="смартфоны")
    make_product(db, title="Dyson HD16", category="красота", brand="Dyson")
    cats = client.get("/api/catalog/categories").json()["categories"]
    assert cats, "категории обязаны быть"
    for c in cats:
        assert c["count"] > 0, f"плитка {c['key']} ведёт в пустоту"
        if c["key"] == SALE_KEY:
            continue
        got = client.get(f"/api/catalog/list?category={c['key']}").json()["cards"]
        assert got, f"плитка {c['key']} отдаёт пустой каталог"


# ---------- сид главной ----------

def test_seed_uses_real_catalog(db):
    make_product(db, title="iPhone", category="смартфоны")
    make_product(db, title="Dyson HD16", category="красота", brand="Dyson")
    values = [c["action_value"] for c in default_categories(db)]
    assert set(values) == {"смартфоны", "красота"}
    assert "dyson" not in values and "аксессуары" not in values


def test_seed_on_empty_catalog_creates_nothing(db):
    assert default_categories(db) == []
    seed_home_defaults(db)
    assert db.query(HomeCategory).count() == 0
    assert db.query(HomeBanner).count() > 0      # баннеры от каталога не зависят


def test_seed_positions_are_sequential(db):
    for cat in ("смартфоны", "ноутбуки", "часы"):
        make_product(db, title=f"t-{cat}", category=cat)
    positions = [c["position"] for c in default_categories(db)]
    assert positions == sorted(positions) and positions[0] == 1


# ---------- словарь категорий для AI: из каталога, а не из кода ----------

def _vocab(db):
    from app.services.catalog_nav import category_vocabulary
    return category_vocabulary(db)


def _seed_shop(db):
    make_product(db, title="Apple iPhone 17 Pro", category="смартфоны", subcategory="iPhone", brand="Apple")
    make_product(db, title="Apple MacBook Air 13", category="ноутбуки", subcategory="MacBook Air", brand="Apple")
    make_product(db, title="Apple Watch Ultra 3", category="часы", subcategory="Apple Watch", brand="Apple")
    make_product(db, title="Dyson HD16", category="красота", subcategory="Фены", brand="Dyson")
    make_product(db, title="Dyson HS05", category="красота", subcategory="Стайлеры", brand="Dyson")
    make_product(db, title="Dyson V16", category="бытовая техника", subcategory="Пылесосы", brand="Dyson")
    make_product(db, title="PlayStation 5", category="консоли", subcategory="Консоли", brand="Sony")


@pytest.mark.parametrize("query,expected", [
    ("посоветуй фен дайсон", "красота"),      # регрессия: раньше -> несуществующая "dyson"
    ("не apple, нужен фен", "красота"),       # бренд в запросе не должен перебивать раздел
    ("стайлер", "красота"),
    ("плойка", "красота"),
    ("пылесос", "бытовая техника"),
    ("часы 49мм", "часы"),                    # раньше -> несуществующая "аксессуары"
    ("apple watch ultra", "часы"),
    ("приставка для сына", "консоли"),
    ("макбук эйр м4 до 120", "ноутбуки"),
    ("айфон 17 про 256", "смартфоны"),
    ("iphone 17 pro max", "смартфоны"),
    ("привет", None),
    ("что-нибудь для дома", None),
])
def test_resolve_category_from_catalog(db, query, expected):
    _seed_shop(db)
    assert resolve_category(query, _vocab(db)) == expected


def test_brand_never_becomes_a_category(db):
    """«Apple Watch» не должен превращать слово apple в категорию «часы»:
    иначе любой запрос со словом apple уезжал бы в часы."""
    _seed_shop(db)
    v = _vocab(db)
    assert "apple" not in v and "dyson" not in v and "sony" not in v


def test_vocabulary_follows_catalog(db):
    """Новый раздел появляется в словаре сам; исчезнувший — пропадает."""
    _seed_shop(db)
    assert resolve_category("робот-пылесос", _vocab(db)) == "бытовая техника"
    p = make_product(db, title="Nothing Ear", category="наушники", subcategory="Наушники TWS")
    assert resolve_category("наушники", _vocab(db)) == "наушники"
    p.is_active = False
    db.commit()
    assert resolve_category("наушники", _vocab(db)) is None


def test_synonym_to_missing_section_is_dropped(db):
    """Разговорное слово, указывающее на раздел, которого нет, не разрешается."""
    make_product(db, title="Apple iPhone 17", category="смартфоны", subcategory="iPhone")
    assert resolve_category("плойка", _vocab(db)) is None      # стайлеров в каталоге нет
    assert resolve_category("айфон", _vocab(db)) == "смартфоны"
