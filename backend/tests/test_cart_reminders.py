"""Напоминание о брошенной корзине (патч 1.1, фича #2).

Самое дорогое здесь — НЕ разослать лишнего. Напоминание уходит от имени
магазина, и второе подряд про ту же корзину читается как спам, а ночное — как
повод отписаться. Поэтому тесты закрепляют границы: idle снизу, возраст сверху,
тихие часы и «одно напоминание на одно состояние корзины».
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models.cart import Cart, CartItem
from app.models.notification import Notification
from app.models.user import User
from app.services import cart_reminders
from tests.conftest import make_product

NOON_UTC = datetime(2026, 7, 30, 9, 0, tzinfo=timezone.utc)  # 12:00 МСК


@pytest.fixture(autouse=True)
def bot_token(monkeypatch):
    """Без токена очередь намеренно не наполняется (см. notifications_enabled)."""
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")


def make_user(db, telegram_id=777) -> User:
    user = User(telegram_id=telegram_id, first_name="Гарик")
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def make_cart(db, user, product, *, idle_hours: float, now=NOON_UTC, quantity=1) -> Cart:
    """Корзина с товаром, «последний раз тронутая» idle_hours назад.

    updated_at выставляем явно: onupdate=func.now() поставил бы текущее время, а
    нам нужен управляемый возраст.
    """
    cart = Cart(user_id=user.id, status="active")
    db.add(cart)
    db.flush()
    db.add(CartItem(cart_id=cart.id, product_id=product.id, quantity=quantity,
                    added_price=product.price, sku=product.sku))
    db.commit()
    stamp = now - timedelta(hours=idle_hours)
    # naive: sqlite в тестах хранит datetime без tz, и сравнение в SQL должно
    # идти между однородными значениями.
    cart.updated_at = stamp.replace(tzinfo=None)
    db.commit()
    db.refresh(cart)
    return cart


def queued(db) -> list[Notification]:
    return db.query(Notification).order_by(Notification.id).all()


def scan(db, now=NOON_UTC):
    return cart_reminders.scan(db, now=now.replace(tzinfo=None))


# ============================ Тихие часы ============================
def test_quiet_hours_cover_the_night():
    # Интервал 22:00–10:00 МСК пересекает полночь — обычное сравнение «от и до»
    # дало бы здесь ровно обратный ответ.
    assert cart_reminders.is_quiet_hour(datetime(2026, 7, 30, 0, 0))     # 03:00 МСК
    assert cart_reminders.is_quiet_hour(datetime(2026, 7, 30, 20, 0))    # 23:00 МСК
    assert not cart_reminders.is_quiet_hour(datetime(2026, 7, 30, 9, 0))  # 12:00 МСК
    assert not cart_reminders.is_quiet_hour(datetime(2026, 7, 30, 15, 0))  # 18:00 МСК


def test_scan_is_silent_at_night(db):
    user = make_user(db)
    product = make_product(db, sku="A")
    make_cart(db, user, product, idle_hours=12)

    night = datetime(2026, 7, 30, 1, 0)  # 04:00 МСК
    stats = cart_reminders.scan(db, now=night)
    assert stats["queued"] == 0
    assert queued(db) == []


# ============================ Границы отбора ============================
def test_fresh_cart_is_not_abandoned(db):
    """Человек прямо сейчас собирает корзину — напоминать нечего."""
    user = make_user(db)
    product = make_product(db, sku="A")
    make_cart(db, user, product, idle_hours=1)

    assert scan(db)["queued"] == 0


def test_idle_cart_gets_reminder(db):
    user = make_user(db)
    product = make_product(db, sku="A", title="MacBook Air", price=129990)
    make_cart(db, user, product, idle_hours=12)

    assert scan(db)["queued"] == 1
    row = queued(db)[0]
    assert row.kind == "cart_reminder"
    assert row.chat_id == 777
    assert "MacBook Air" in row.text


def test_ancient_cart_is_skipped(db):
    """Корзина недельной давности — уже не забота, а спам."""
    user = make_user(db)
    product = make_product(db, sku="A")
    make_cart(db, user, product, idle_hours=24 * 7)

    assert scan(db)["queued"] == 0


def test_converted_cart_is_skipped(db):
    """Заявка уже отправлена — напоминать о ней как о брошенной нельзя."""
    user = make_user(db)
    product = make_product(db, sku="A")
    cart = make_cart(db, user, product, idle_hours=12)
    cart.status = "converted"
    db.commit()

    assert scan(db)["queued"] == 0


def test_empty_cart_is_skipped(db):
    user = make_user(db)
    cart = Cart(user_id=user.id, status="active")
    db.add(cart)
    db.commit()
    cart.updated_at = (NOON_UTC - timedelta(hours=12)).replace(tzinfo=None)
    db.commit()

    assert scan(db)["queued"] == 0


# ============================ Идемпотентность ============================
def test_second_scan_does_not_remind_twice(db):
    """Главное правило: одно напоминание на одно состояние корзины."""
    user = make_user(db)
    product = make_product(db, sku="A")
    make_cart(db, user, product, idle_hours=12)

    assert scan(db)["queued"] == 1
    assert scan(db)["queued"] == 0
    assert scan(db)["queued"] == 0
    assert len(queued(db)) == 1


def test_changed_cart_can_be_reminded_again(db):
    """Человек доложил товар и снова бросил — это новое состояние, новый повод."""
    user = make_user(db)
    product = make_product(db, sku="A")
    cart = make_cart(db, user, product, idle_hours=12)
    assert scan(db)["queued"] == 1

    other = make_product(db, sku="B", title="AirPods")
    db.add(CartItem(cart_id=cart.id, product_id=other.id, quantity=1,
                    added_price=other.price, sku=other.sku))
    db.commit()
    cart.updated_at = (NOON_UTC - timedelta(hours=8)).replace(tzinfo=None)
    db.commit()

    assert scan(db)["queued"] == 1
    assert len(queued(db)) == 2


# ============================ Содержание ============================
def test_reminder_total_uses_current_catalog_price(db):
    """Сумма считается по актуальной цене, а не по снапшоту added_price.

    Иначе напоминание назовёт цену, которой в приложении уже нет, — и человек
    придёт с претензией к цифре, которую прислал сам магазин.
    """
    user = make_user(db)
    product = make_product(db, sku="A", title="iPhone", price=100000)
    make_cart(db, user, product, idle_hours=12, quantity=2)

    product.price = 90000
    db.commit()

    scan(db)
    assert "180 000 ₽" in queued(db)[0].text


def test_reminder_skipped_when_disabled(db, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.CART_REMINDER_ENABLED", False)
    user = make_user(db)
    product = make_product(db, sku="A")
    make_cart(db, user, product, idle_hours=12)

    assert scan(db)["queued"] == 0
