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
from app.models.product import Product
from app.services.ai_retrieval import ExtractedFilters, retrieve_candidates
from app.services.availability import price_note, resolve_availability
from app.services.ranking import category_priority, product_sort_key
from tests.conftest import make_product


def _preorder(db, **kw) -> Product:
    kw.setdefault("title", "iPhone 18 Pro 256 ГБ")
    kw.setdefault("price", 0)
    kw.setdefault("in_stock", False)
    kw.setdefault("stock", 0)
    return make_product(
        db,
        availability_mode="preorder",
        preorder_eta="18 сентября",
        preorder_group="apple-sept-2026",
        accent_color="#6E2639",
        **kw,
    )


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
