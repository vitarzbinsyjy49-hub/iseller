"""Слежение за избранным (патч 1.1, фича #3).

Самая дорогая ошибка здесь — не «не отправили», а «отправили лишнее»: избранное
копится месяцами, и один неверный прогон превращается в рассылку по сотням
товаров, о которых человек не спрашивал. Поэтому большая часть тестов
проверяет МОЛЧАНИЕ, а не отправку.
"""
from datetime import datetime, timezone

import pytest

from app.models.favorite import ProductFavorite
from app.models.notification import Notification
from app.models.user import User
from app.services import favorite_watch
from tests.conftest import make_product

NOON_UTC = datetime(2026, 7, 30, 9, 0, tzinfo=timezone.utc)  # 12:00 МСК
NIGHT_UTC = datetime(2026, 7, 30, 1, 0, tzinfo=timezone.utc)  # 04:00 МСК


@pytest.fixture(autouse=True)
def bot_token(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")


def make_user(db, telegram_id=777) -> User:
    user = User(telegram_id=telegram_id, first_name="Гарик")
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def favorite(db, user, product, *, notified_price=None, notified_in_stock=None):
    """Избранное с явными отметками. None = «мы ещё ничего не сообщали»."""
    row = ProductFavorite(
        user_id=user.id, product_id=product.id,
        notified_price=notified_price, notified_in_stock=notified_in_stock,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def queued(db) -> list[Notification]:
    return db.query(Notification).order_by(Notification.id).all()


def scan(db, now=NOON_UTC):
    return favorite_watch.scan(db, now=now)


# ==================== Первый скан обязан молчать ====================
def test_first_scan_initializes_and_stays_silent(db):
    """Строки, существовавшие до патча, не имеют отметок.

    Если считать их «новостью», выкладка патча превратится в рассылку по всему
    избранному всех пользователей разом. Первый скан ЗАПОМИНАЕТ состояние.
    """
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    row = favorite(db, user, product)

    stats = scan(db)

    assert stats["initialized"] == 1 and stats["queued"] == 0
    assert queued(db) == []
    db.refresh(row)
    assert float(row.notified_price) == 100000
    assert row.notified_in_stock is True


def test_second_scan_after_init_is_silent(db):
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    favorite(db, user, product)

    scan(db)
    assert scan(db)["queued"] == 0
    assert queued(db) == []


# ==================== Снижение цены ====================
def test_significant_drop_notifies(db):
    user = make_user(db)
    product = make_product(db, sku="A", title="iPhone 17 Pro", price=100000)
    favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 90000
    db.commit()

    assert scan(db)["queued"] == 1
    row = queued(db)[0]
    assert row.kind == "favorite_price"
    assert "iPhone 17 Pro" in row.text
    assert "90 000 ₽" in row.text and "было 100 000 ₽" in row.text


def test_tiny_drop_is_not_news(db):
    """«Минус 300 рублей» обесценивает следующее уведомление, настоящее."""
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 99700
    db.commit()

    assert scan(db)["queued"] == 0


def test_price_rise_is_never_reported(db):
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 130000
    db.commit()

    assert scan(db)["queued"] == 0
    assert queued(db) == []


def test_same_drop_is_reported_once(db):
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 90000
    db.commit()

    assert scan(db)["queued"] == 1
    assert scan(db)["queued"] == 0
    assert len(queued(db)) == 1


def test_oscillating_price_does_not_spam(db):
    """100 -> 90 -> 100 -> 90 обязано дать ОДНО сообщение, а не три.

    Ради этого отметка цены только убывает: человек уже знает, что 90 бывает.
    """
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    row = favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    for price in (90000, 100000, 90000, 100000, 90000):
        product.price = price
        db.commit()
        scan(db)

    assert len(queued(db)) == 1
    db.refresh(row)
    assert float(row.notified_price) == 90000


def test_further_drop_notifies_again(db):
    """Подешевело ещё раз — это новая новость, а не повтор старой."""
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 90000
    db.commit()
    scan(db)

    product.price = 80000
    db.commit()
    scan(db)

    texts = [n.text for n in queued(db)]
    assert len(texts) == 2
    assert "было 90 000 ₽" in texts[1]


# ==================== Снова в наличии ====================
def test_back_in_stock_notifies(db):
    user = make_user(db)
    product = make_product(db, sku="A", title="Dyson HD16", price=26500,
                           in_stock=False)
    favorite(db, user, product, notified_price=26500, notified_in_stock=False)

    product.in_stock = True
    db.commit()

    assert scan(db)["queued"] == 1
    assert "Снова в наличии" in queued(db)[0].text


def test_on_request_is_not_called_in_stock(db):
    """«Под заказ» — не наличие. Сказать иначе значит позвать за тем, чего нет.

    on_request и preorder проходят как orderable (их можно заказать), поэтому
    соблазн считать их «в наличии» велик — и он ошибочен.
    """
    user = make_user(db)
    product = make_product(db, sku="A", price=1000, in_stock=False,
                           availability_mode="on_request")
    favorite(db, user, product, notified_price=1000, notified_in_stock=False)

    assert scan(db)["queued"] == 0

    product.availability_mode = "preorder"
    db.commit()
    assert scan(db)["queued"] == 0


def test_going_out_of_stock_resets_the_flag(db):
    """Ушёл со склада — отметка обязана вернуться в False.

    Иначе следующее поступление не будет распознано как новость, и человек,
    ждавший именно его, ничего не узнает.
    """
    user = make_user(db)
    product = make_product(db, sku="A", price=1000, in_stock=True)
    row = favorite(db, user, product, notified_price=1000, notified_in_stock=True)

    product.in_stock = False
    db.commit()
    scan(db)
    db.refresh(row)
    assert row.notified_in_stock is False
    assert queued(db) == []

    product.in_stock = True
    db.commit()
    assert scan(db)["queued"] == 1


def test_back_in_stock_and_cheaper_send_one_message(db):
    """Две новости про один товар — одно сообщение, а не два подряд."""
    user = make_user(db)
    product = make_product(db, sku="A", price=100000, in_stock=False)
    favorite(db, user, product, notified_price=100000, notified_in_stock=False)

    product.in_stock = True
    product.price = 80000
    db.commit()

    assert scan(db)["queued"] == 1
    text = queued(db)[0].text
    assert "Снова в наличии" in text
    assert "80 000 ₽" in text


# ==================== Границы и тишина ====================
def test_hidden_product_is_ignored(db):
    """Снятый с публикации товар не повод для новостей."""
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 50000
    product.is_active = False
    db.commit()

    assert scan(db)["queued"] == 0


def test_quiet_hours_delay_price_drop_without_losing_it(db):
    """Ночью молчим, но снижение не теряем — оно уедет дневным сканом."""
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 90000
    db.commit()

    assert favorite_watch.scan(db, now=NIGHT_UTC)["queued"] == 0
    assert queued(db) == []

    assert favorite_watch.scan(db, now=NOON_UTC)["queued"] == 1


def test_disabled_watch_does_nothing(db, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.FAVORITE_WATCH_ENABLED", False)
    user = make_user(db)
    product = make_product(db, sku="A", price=100000)
    favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 50000
    db.commit()

    assert scan(db)["queued"] == 0


def test_each_user_gets_their_own_message(db):
    """Подешевел популярный товар — сообщение каждому, кто его отметил."""
    product = make_product(db, sku="A", price=100000)
    for tg in (111, 222, 333):
        user = make_user(db, telegram_id=tg)
        favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 80000
    db.commit()

    assert scan(db)["queued"] == 3
    assert {n.chat_id for n in queued(db)} == {111, 222, 333}


def test_scan_respects_limit(db):
    product = make_product(db, sku="A", price=100000)
    for tg in range(100, 105):
        user = make_user(db, telegram_id=tg)
        favorite(db, user, product, notified_price=100000, notified_in_stock=True)

    product.price = 80000
    db.commit()

    assert favorite_watch.scan(db, now=NOON_UTC, limit=2)["queued"] == 2


# ==================== Отметка при добавлении ====================
def test_price_dropped_needs_a_baseline():
    """Без точки отсчёта снижения не существует — это не «снизилась на всё»."""
    assert favorite_watch.price_dropped(50, None) is False
    assert favorite_watch.price_dropped(50, 100) is True
    assert favorite_watch.price_dropped(100, 100) is False
    assert favorite_watch.price_dropped(50, 0) is False


# ==================== Отметка ставится при добавлении ====================
@pytest.fixture()
def api(db, monkeypatch):
    """TestClient от лица пользователя с Telegram-id."""
    from fastapi.testclient import TestClient

    from app.api.deps import get_current_user
    from app.db.session import get_db
    from app.main import app

    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")
    user = make_user(db, telegram_id=555)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    try:
        yield TestClient(app), db, user
    finally:
        app.dependency_overrides.clear()


def test_adding_to_favorites_records_the_baseline(api):
    """Отметка ставится СРАЗУ, а не первым сканом.

    Иначе товар, добавленный между сканами, получил бы отметку с ценой на
    момент скана — и снижение, случившееся в этом промежутке, пропало бы молча.
    """
    client, db, user = api
    product = make_product(db, sku="A", price=100000)

    client.put(f"/api/favorites/{product.id}")

    row = db.query(ProductFavorite).one()
    assert float(row.notified_price) == 100000
    assert row.notified_in_stock is True


def test_fresh_favorite_does_not_fire_on_next_scan(api):
    client, db, user = api
    product = make_product(db, sku="A", price=100000)
    client.put(f"/api/favorites/{product.id}")

    assert scan(db)["queued"] == 0
    assert queued(db) == []


def test_favorite_of_out_of_stock_item_waits_for_arrival(api):
    """Главный сценарий фичи: отметил то, чего нет, — узнал о поступлении."""
    client, db, user = api
    product = make_product(db, sku="A", title="PS5 Pro", price=80000, in_stock=False)

    client.put(f"/api/favorites/{product.id}")
    row = db.query(ProductFavorite).one()
    assert row.notified_in_stock is False

    product.in_stock = True
    db.commit()

    assert scan(db)["queued"] == 1
    assert "PS5 Pro" in queued(db)[0].text


def test_merged_favorites_get_the_baseline_too(api):
    """Слияние гостевого избранного — тот же путь, что и обычное добавление.

    Без отметки слитые строки выглядели бы для скана как «первое знакомство» и
    молча съедали бы первое же снижение цены.
    """
    client, db, user = api
    a = make_product(db, sku="A", price=50000)
    b = make_product(db, sku="B", price=70000)

    client.post("/api/favorites/merge", json={"ids": [a.id, b.id]})

    rows = db.query(ProductFavorite).order_by(ProductFavorite.product_id).all()
    assert len(rows) == 2
    assert all(r.notified_price is not None and r.notified_in_stock is not None
               for r in rows)
