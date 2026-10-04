"""Порядок выдачи каталога, когда популярность ещё не набрана.

Задача: витрина не должна быть случайной. `popularity` — честное число из
реального спроса, но пока спроса нет, оно у всех нулевое, и `ORDER BY popularity`
вырождается: Postgres отдаёт строки в произвольном порядке, наверх лезет то, что
импортировали первым.

Чинить это списком «что важнее» в коде нельзя — такой список разъедется с базой
ровно так же, как когда-то разъехался список категорий (см. catalog_nav).
Поэтому приор берём из уже принятого решения: порядок плиток на главной
(`home_categories.position`), который редактируется в админке.
"""
from datetime import datetime, timedelta, timezone

from app.models.home import HomeCategory
from app.models.product import Product
from app.models.user_product_event import UserProductEvent
from app.services.ranking import NO_TILE_RANK, category_priority, product_sort_key, view_counts
from tests.conftest import make_product


def _tile(db, title, value, position, **kw):
    t = HomeCategory(title=title, action_type=kw.pop("action_type", "category"),
                     action_value=value, position=position, **kw)
    db.add(t)
    db.commit()
    return t


def _titles_in_order(db, products):
    prio = category_priority(db)
    return [p.title for p in sorted(products, key=lambda p: product_sort_key(p, prio))]


def test_priority_comes_from_home_tiles(db):
    _tile(db, "Смартфоны", "смартфоны", 1)
    _tile(db, "Ноутбуки", "ноутбуки", 2)
    assert category_priority(db) == {"смартфоны": 1, "ноутбуки": 2}


def test_priority_ignores_sale_brand_and_hidden_tiles(db):
    _tile(db, "Смартфоны", "смартфоны", 1)
    _tile(db, "Скидки", "__sale__", 2)                       # виртуальная категория
    _tile(db, "Dyson", "Dyson", 3, action_type="brand")      # ось брендов, не категория
    _tile(db, "Часы", "часы", 4, is_active=False)            # осознанно скрыта
    assert category_priority(db) == {"смартфоны": 1}


def test_category_order_decides_when_popularity_is_zero(db):
    """Главный сценарий: популярности нет ни у кого, порядок задают плитки."""
    _tile(db, "Смартфоны", "смартфоны", 1)
    _tile(db, "Ноутбуки", "ноутбуки", 2)
    _tile(db, "Наушники", "наушники", 3)
    items = [
        make_product(db, title="AirPods", category="наушники", popularity=0, price=20000),
        make_product(db, title="MacBook", category="ноутбуки", popularity=0, price=200000),
        make_product(db, title="iPhone", category="смартфоны", popularity=0, price=100000),
    ]
    assert _titles_in_order(db, items) == ["iPhone", "MacBook", "AirPods"]


def test_real_popularity_beats_the_prior(db):
    """Как только спрос появился, он важнее редакторского порядка категорий."""
    _tile(db, "Смартфоны", "смартфоны", 1)
    _tile(db, "Наушники", "наушники", 3)
    items = [
        make_product(db, title="iPhone", category="смартфоны", popularity=0, price=100000),
        make_product(db, title="AirPods", category="наушники", popularity=50, price=20000),
    ]
    assert _titles_in_order(db, items) == ["AirPods", "iPhone"]


def test_inside_one_category_flagship_first(db):
    """Внутри категории вперёд идёт старшая модель — цена как прокси флагмана."""
    _tile(db, "Смартфоны", "смартфоны", 1)
    items = [
        make_product(db, title="iPhone 17", category="смартфоны", popularity=0, price=90000),
        make_product(db, title="iPhone 17 Pro Max", category="смартфоны", popularity=0, price=200000),
    ]
    assert _titles_in_order(db, items) == ["iPhone 17 Pro Max", "iPhone 17"]


def test_category_without_tile_goes_last_but_stays_visible(db):
    """Категория без плитки не исчезает — просто уходит вниз (как Dyson сейчас)."""
    _tile(db, "Смартфоны", "смартфоны", 1)
    items = [
        make_product(db, title="Dyson", category="красота", popularity=0, price=500000),
        make_product(db, title="iPhone", category="смартфоны", popularity=0, price=100000),
    ]
    assert _titles_in_order(db, items) == ["iPhone", "Dyson"]
    # Ранг категории — в ключе сортировки; ищем его по значению, а не по номеру
    # позиции: над ним уже появился закреплённый флаг, и номер ещё будет ехать.
    assert NO_TILE_RANK in product_sort_key(items[0], category_priority(db))


def test_in_stock_still_wins_over_everything(db):
    _tile(db, "Смартфоны", "смартфоны", 1)
    _tile(db, "Наушники", "наушники", 3)
    items = [
        make_product(db, title="iPhone нет в наличии", category="смартфоны",
                     popularity=99, price=100000, in_stock=False),
        make_product(db, title="AirPods в наличии", category="наушники",
                     popularity=0, price=20000),
    ]
    assert _titles_in_order(db, items) == ["AirPods в наличии", "iPhone нет в наличии"]


def test_order_is_fully_deterministic(db):
    """Ни одна пара товаров не должна остаться неразличимой: одинаковый ключ
    сортировки = снова произвольный порядок, ровно та беда, что чиним."""
    _tile(db, "Смартфоны", "смартфоны", 1)
    items = [make_product(db, title="Одинаковый %d" % i, category="смартфоны",
                          popularity=0, price=100000) for i in range(5)]
    prio = category_priority(db)
    keys = [product_sort_key(p, prio) for p in items]
    assert len(set(keys)) == len(keys)


def test_no_tiles_at_all_does_not_crash(db):
    """Пустая таблица плиток — не повод падать: остаётся цена и id."""
    items = [
        make_product(db, title="Дешёвый", category="смартфоны", popularity=0, price=1000),
        make_product(db, title="Дорогой", category="смартфоны", popularity=0, price=9000),
    ]
    assert _titles_in_order(db, items) == ["Дорогой", "Дешёвый"]


# ---------------------------------------------------------------- view_counts

def _view(db, product_id, *, days_ago: float = 0.0, user_id: int = 1):
    db.add(UserProductEvent(
        user_id=user_id, product_id=product_id, event_type="product_view",
        created_at=datetime.now(timezone.utc) - timedelta(days=days_ago),
    ))
    db.commit()


def test_view_counts_counts_product_views(db):
    a = make_product(db, title="A")
    b = make_product(db, title="B")
    _view(db, a.id, user_id=1)
    _view(db, a.id, user_id=2)
    _view(db, b.id, user_id=1)
    counts = view_counts(db)
    assert counts == {a.id: 2, b.id: 1}


def test_view_counts_ignores_other_event_types(db):
    """Только product_view — заявки/избранное считает social_proof.py, не это."""
    p = make_product(db, title="P")
    db.add(UserProductEvent(user_id=1, product_id=p.id, event_type="lead_created"))
    db.add(UserProductEvent(user_id=1, product_id=p.id, event_type="favorite_add"))
    db.commit()
    assert view_counts(db) == {}


def test_view_counts_respects_window(db):
    p = make_product(db, title="P")
    _view(db, p.id, days_ago=200)   # за пределами окна по умолчанию (90 дн.)
    assert view_counts(db) == {}
    assert view_counts(db, window_days=365) == {p.id: 1}


def test_view_counts_empty_when_no_events(db):
    make_product(db, title="P")
    assert view_counts(db) == {}


def test_promo_boost_lifts_flagship_above_demand_but_not_above_stock(db):
    """Редакторское продвижение (запуск новой модели) выше спроса: у новинки
    просмотров ещё нет, и без него она неделю стояла бы под прошлогодней
    моделью. Но ниже наличия — продвигать то, что нельзя купить, нельзя."""
    from sqlalchemy import select

    from app.services.ranking import default_order

    items = [
        make_product(db, title="iPhone 17 Pro", popularity=13, price=100000),
        make_product(db, title="iPhone 18 Pro", popularity=0, price=127000, promo_boost=10),
        make_product(db, title="iPhone 18 Pro нет", popularity=0, price=1, promo_boost=10,
                     in_stock=False),
    ]
    assert _titles_in_order(db, items) == ["iPhone 18 Pro", "iPhone 17 Pro", "iPhone 18 Pro нет"]
    sql = [p.title for p in db.execute(select(Product).order_by(*default_order(db))).scalars()]
    assert sql == ["iPhone 18 Pro", "iPhone 17 Pro", "iPhone 18 Pro нет"]


# ---------------------------------------------------------------- новизна

def _seen(days: float):
    return datetime.now(timezone.utc) - timedelta(days=days)


def _sql_titles(db):
    from sqlalchemy import select

    from app.services.ranking import default_order
    return [p.title for p in db.execute(select(Product).order_by(*default_order(db))).scalars()]


def test_fresh_model_beats_popular_old_one(db):
    """Спека 04.10: iPhone 18 без истории просмотров не должен стоять под
    прошлогодним 17-м только потому, что спрос ещё не набрался."""
    items = [
        make_product(db, title="iPhone 17", popularity=50, price=90000,
                     model_first_seen_at=_seen(300)),
        make_product(db, title="iPhone 18", popularity=0, price=100000,
                     model_first_seen_at=_seen(5)),
    ]
    assert _titles_in_order(db, items) == ["iPhone 18", "iPhone 17"]
    assert _sql_titles(db) == ["iPhone 18", "iPhone 17"]


def test_novelty_sits_below_stock_and_promo(db):
    """Новизна — ниже наличия и ручного продвижения: поднять старый товар
    по-прежнему можно promo_boost, а свежий без наличия не лезет наверх."""
    items = [
        make_product(db, title="свежий нет в наличии", in_stock=False, popularity=0,
                     model_first_seen_at=_seen(1)),
        make_product(db, title="старый с промо", promo_boost=5, popularity=0,
                     model_first_seen_at=_seen(400)),
        make_product(db, title="свежий", popularity=0, model_first_seen_at=_seen(2)),
    ]
    expected = ["старый с промо", "свежий", "свежий нет в наличии"]
    assert _titles_in_order(db, items) == expected
    assert _sql_titles(db) == expected


def test_newer_fresh_model_goes_first_old_ones_tie(db):
    """Среди свежих — более новая выше; у несвежих ступень одинаковая, и
    решение уходит в популярность (а не в «кто старше»)."""
    items = [
        make_product(db, title="свежий 20 дн", popularity=0, model_first_seen_at=_seen(20)),
        make_product(db, title="свежий 2 дн", popularity=0, model_first_seen_at=_seen(2)),
        make_product(db, title="старый популярный", popularity=30, model_first_seen_at=_seen(100)),
        make_product(db, title="очень старый, ещё популярнее", popularity=40,
                     model_first_seen_at=_seen(900)),
        make_product(db, title="без даты", popularity=35, model_first_seen_at=None),
    ]
    expected = ["свежий 2 дн", "свежий 20 дн", "очень старый, ещё популярнее",
                "без даты", "старый популярный"]
    assert _titles_in_order(db, items) == expected
    assert _sql_titles(db) == expected


def test_sql_and_python_orders_agree(db):
    """Одно правило в двух исполнениях (SQL для каталога, Python для
    рекомендаций): на одном наборе они обязаны давать один порядок."""
    _tile(db, "Смартфоны", "смартфоны", 1)
    _tile(db, "Ноутбуки", "ноутбуки", 2)
    combos = [
        dict(in_stock=True, promo_boost=0, popularity=0, days=3, category="смартфоны"),
        dict(in_stock=True, promo_boost=0, popularity=0, days=30, category="смартфоны"),
        dict(in_stock=True, promo_boost=0, popularity=9, days=200, category="смартфоны"),
        dict(in_stock=True, promo_boost=0, popularity=9, days=None, category="ноутбуки"),
        dict(in_stock=True, promo_boost=3, popularity=0, days=500, category="ноутбуки"),
        dict(in_stock=False, promo_boost=0, popularity=0, days=1, category="смартфоны"),
        dict(in_stock=True, promo_boost=0, popularity=0, days=3, category="ноутбуки"),
        dict(in_stock=True, promo_boost=0, popularity=0, days=3, category="наушники"),
        dict(in_stock=True, promo_boost=0, popularity=0, days=200, category="наушники"),
    ]
    items = []
    for i, c in enumerate(combos):
        days = c.pop("days")
        items.append(make_product(db, title=f"T{i}", price=1000 * (i % 3 + 1),
                                  model_first_seen_at=_seen(days) if days is not None else None,
                                  **c))
    items.append(make_product(db, title="L", is_legendary=True, popularity=0))
    assert _titles_in_order(db, items) == _sql_titles(db)


# ---------------------------------------------------------------- recompute_popularity

def test_recompute_popularity_writes_views_and_counts_changes(db):
    """Тело scripts/recompute_popularity — теперь функция: её зовёт цикл бота
    раз в сутки, иначе 298 просмотров так и лежали бы без пользы."""
    from app.services.ranking import recompute_popularity

    seen = make_product(db, title="смотрят", popularity=0)
    stale = make_product(db, title="был популярен", popularity=50)
    quiet = make_product(db, title="ноль и так", popularity=0)
    _view(db, seen.id, user_id=1)
    _view(db, seen.id, user_id=2)

    assert recompute_popularity(db) == 2
    db.expire_all()
    assert db.get(Product, seen.id).popularity == 2
    assert db.get(Product, stale.id).popularity == 0
    assert db.get(Product, quiet.id).popularity == 0
    assert recompute_popularity(db) == 0            # идемпотентно


def test_recompute_popularity_dry_run_writes_nothing(db):
    from app.services.ranking import recompute_popularity

    p = make_product(db, title="смотрят", popularity=0)
    _view(db, p.id)
    assert recompute_popularity(db, dry_run=True) == 1
    db.expire_all()
    assert db.get(Product, p.id).popularity == 0
