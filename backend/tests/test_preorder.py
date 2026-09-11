"""Предзаказ: товар анонсирован, но ещё не приехал.

Три вещи, которые здесь держатся, и каждая уже один раз стоила бы дорого:

1. **Цены нет.** Собственной цены у такого товара не существует, а любая цифра на
   витрине читается как обещание магазина. Признак «цену называть нельзя» —
   непустой `price_note`, один на ленту, деталку и корзину. Проверять
   `price == 0` в каждом компоненте значит завести три разных правила про одно.
2. **Ступень в сортировке.** У предзаказа `in_stock=False` по определению, и без
   отдельной ступени он тонет в самый низ каталога: формально там есть,
   практически невидим.
3. **AI его не видит.** Иначе он посоветует «телефон на сегодня» тем, чего нет в
   продаже, и придумает характеристики устройства, которого никто не держал.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from sqlalchemy import select

from app.db.session import get_db
from app.main import app
from app.models.home import HomeBanner
from app.models.product import Product
from app.models.user import User
from app.services.ai_retrieval import ExtractedFilters, retrieve_candidates
from app.services.availability import price_note, resolve_availability
from app.services.ranking import category_priority, product_sort_key
from tests.conftest import make_product


@pytest.fixture()
def client(db):
    user = User(telegram_id=778, first_name="Покупатель")
    db.add(user)
    db.commit()
    db.refresh(user)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _preorder(db, **kw) -> Product:
    kw.setdefault("title", "iPhone 18 Pro 256 ГБ")
    kw.setdefault("price", 0)
    kw.setdefault("in_stock", False)
    kw.setdefault("stock", 0)
    kw.setdefault("availability_mode", "preorder")
    kw.setdefault("preorder_eta", "18 сентября")
    kw.setdefault("preorder_group", "apple-sept-2026")
    kw.setdefault("accent_color", "#6E2639")
    return make_product(db, **kw)


# ---------- цена ----------

def test_preorder_hides_price_behind_a_note(db):
    p = _preorder(db)
    assert resolve_availability(p) == "preorder"
    assert price_note(p) == "Цену уточнит менеджер"
    assert p.to_card()["price_note"] == "Цену уточнит менеджер"


def test_ordinary_product_has_no_price_note(db):
    p = make_product(db)
    assert price_note(p) == ""
    assert p.to_card()["price_note"] == ""


def test_out_of_stock_is_not_a_preorder(db):
    """«Нет в наличии» цену не прячет: у обычного товара цена известна."""
    p = make_product(db, availability_mode="out_of_stock", in_stock=False)
    assert p.to_card()["price_note"] == ""


# ---------- поля доезжают до витрины и админки ----------

def test_preorder_fields_reach_card_and_admin(db):
    card = _preorder(db).to_card()
    assert card["preorder_eta"] == "18 сентября"
    assert card["accent_color"] == "#6E2639"

    admin = _preorder(db, sku="X2").to_admin()
    assert admin["preorder_eta"] == "18 сентября"
    assert admin["preorder_group"] == "apple-sept-2026"
    assert admin["accent_color"] == "#6E2639"


def test_detail_carries_the_note_too(db):
    assert _preorder(db).to_detail()["price_note"] == "Цену уточнит менеджер"


# ---------- сортировка ----------

def test_preorder_outranks_products_in_stock(db):
    """Ступень временная и сознательная: без неё предзаказ уходит в самый низ."""
    in_stock = make_product(db, title="В наличии")
    pre = _preorder(db, title="Предзаказ")
    prio = category_priority(db)
    order = sorted([in_stock, pre], key=lambda p: product_sort_key(p, prio))
    assert [p.title for p in order] == ["Предзаказ", "В наличии"]


def test_legendary_still_outranks_preorder(db):
    """Легендарная позиция остаётся выше всего — её порядок менять не собирались."""
    pre = _preorder(db, title="Предзаказ")
    legend = make_product(db, title="Легенда", is_legendary=True)
    prio = category_priority(db)
    order = sorted([pre, legend], key=lambda p: product_sort_key(p, prio))
    assert [p.title for p in order] == ["Легенда", "Предзаказ"]


def test_preorder_does_not_disturb_ordinary_pairs(db):
    """Ступень добавлена, а не подменила существующие: в наличии выше, чем без."""
    gone = make_product(db, title="Кончился", in_stock=False)
    here = make_product(db, title="Есть")
    prio = category_priority(db)
    order = sorted([gone, here], key=lambda p: product_sort_key(p, prio))
    assert [p.title for p in order] == ["Есть", "Кончился"]


# ---------- невидимость для AI ----------

def test_ai_never_retrieves_a_preorder(db):
    _preorder(db, title="iPhone 18 Pro 256 ГБ")
    real = make_product(db, title="iPhone 16 Pro 256 ГБ")
    found = retrieve_candidates(db, "нужен айфон", ExtractedFilters(), limit=10)
    assert [p.id for p in found] == [real.id]


# ---------- экран события ----------

def test_event_returns_only_its_own_group(db, client):
    db.add(HomeBanner(title="Шесть новых устройств", subtitle="Предзаказ открыт",
                      action_type="preorder", action_value="apple-sept-2026", position=0))
    db.commit()

    first = _preorder(db, title="iPhone 18 Pro", sku="A1")
    second = _preorder(db, title="iPhone Duo", sku="A2", preorder_eta="23 октября")
    _preorder(db, title="Чужое событие", sku="B1", preorder_group="other")
    _preorder(db, title="Снят с публикации", sku="B2", is_active=False)
    make_product(db, title="Обычный товар", sku="C1")

    r = client.get("/api/preorder/apple-sept-2026")
    assert r.status_code == 200
    body = r.json()
    assert body["banner"]["title"] == "Шесть новых устройств"
    assert [i["id"] for i in body["items"]] == [first.id, second.id]
    assert body["items"][1]["preorder_eta"] == "23 октября"


def test_empty_group_is_not_an_error(db, client):
    """Группа пустеет сама, когда товары приехали. Это конец жизни события."""
    r = client.get("/api/preorder/apple-sept-2026")
    assert r.status_code == 200
    assert r.json() == {"banner": None, "items": []}


# ---------- секция на главной ----------

def test_feed_exposes_a_preorder_section(db, client):
    pre = _preorder(db, title="iPhone 18 Pro")
    make_product(db, title="Обычный товар", sku="C1")
    body = client.get("/api/catalog/feed").json()
    assert [c["id"] for c in body["preorder"]] == [pre.id]


def test_feed_section_is_empty_without_preorders(db, client):
    make_product(db, title="Обычный товар")
    assert client.get("/api/catalog/feed").json()["preorder"] == []


# ---------- сид ----------

def test_seed_is_idempotent_and_keeps_banner_first(db, monkeypatch):
    """Повторный запуск не плодит товары и не отодвигает ленту всё дальше.

    Позиции баннеров пересчитываются целиком, а не сдвигаются на +1: сдвиг
    сделал бы каждый следующий запуск хуже предыдущего.
    """
    from app.scripts import seed_preorder_apple_2026 as seed

    gta = HomeBanner(title="GTA VI + PS5 Pro", action_type="product",
                     action_value="1", position=0)
    db.add(gta)
    db.commit()

    monkeypatch.setattr(seed, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)

    seed.main()
    seed.main()

    items = db.execute(
        select(Product).where(Product.preorder_group == seed.GROUP)
    ).scalars().all()
    assert len(items) == len(seed.DEVICES)
    assert all(p.availability_mode == "preorder" for p in items)
    assert all(float(p.price) == 0 for p in items)
    assert all(len(p.images) >= 2 for p in items)

    banners = db.execute(
        select(HomeBanner).order_by(HomeBanner.position.asc())
    ).scalars().all()
    assert banners[0].action_type == "preorder"
    assert banners[1].title == "GTA VI + PS5 Pro"
    assert banners[1].position == 1
