"""Промокоды: проверка, расчёт скидки и списание.

Главное правило сценария и главный предмет этих тестов: ПРОВЕРКА кода купон не
тратит, тратит только оформление заявки. Иначе любой зашедший «попробовать»
сжигал бы акцию, ничего не купив.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models.promo import PromoCode, PromoRedemption

# Импорт наверху, а не внутри теста: он регистрирует таблицу loyalty_settings,
# а create_all в фикстуре db выполняется раньше тела теста. Промокоды её
# касаются через проверку «первая покупка», которая ходит в журнал лояльности.
from app.models.loyalty_settings import LoyaltySettings  # noqa: F401
from app.models.user import User
from app.services import promo as promo_service
from app.services.promo import PromoError


@pytest.fixture()
def user(db):
    u = User(telegram_id=900, first_name="Гриша", username="grisha")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture()
def other_user(db):
    u = User(telegram_id=901, first_name="Оля", username="olya")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def make_code(db, **kw):
    defaults = dict(code="START20", discount_amount=5000, max_redemptions=20,
                    min_order_amount=None, expires_at=None, is_active=True)
    defaults.update(kw)
    row = PromoCode(**defaults)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ---------------- нормализация ----------------

def test_code_is_case_insensitive_and_trimmed():
    assert promo_service.normalize_code("  start20 ") == "START20"


def test_empty_code_rejected():
    with pytest.raises(PromoError):
        promo_service.normalize_code("   ")


def test_absurdly_long_code_rejected():
    with pytest.raises(PromoError):
        promo_service.normalize_code("A" * 200)


# ---------------- проверка ----------------

def test_unknown_code_rejected(db, user):
    with pytest.raises(PromoError) as e:
        promo_service.validate(db, "NOPE", user_id=user.id, order_total=100000)
    assert "не найден" in str(e.value).lower() or "не действует" in str(e.value).lower()


def test_inactive_code_rejected(db, user):
    make_code(db, is_active=False)
    with pytest.raises(PromoError):
        promo_service.validate(db, "START20", user_id=user.id, order_total=100000)


def test_expired_code_rejected(db, user):
    make_code(db, expires_at=datetime.now(timezone.utc) - timedelta(days=1))
    with pytest.raises(PromoError) as e:
        promo_service.validate(db, "START20", user_id=user.id, order_total=100000)
    assert "истёк" in str(e.value).lower()


def test_future_expiry_is_fine(db, user):
    make_code(db, expires_at=datetime.now(timezone.utc) + timedelta(days=1))
    assert promo_service.validate(db, "START20", user_id=user.id, order_total=100000).discount == 5000


def test_min_order_amount_enforced(db, user):
    make_code(db, min_order_amount=50000)
    with pytest.raises(PromoError) as e:
        promo_service.validate(db, "START20", user_id=user.id, order_total=10000)
    assert "50" in str(e.value)
    assert promo_service.validate(db, "START20", user_id=user.id, order_total=50000).discount == 5000


def test_discount_never_exceeds_order_total(db, user):
    """Скидка больше корзины не делает сумму отрицательной."""
    make_code(db, discount_amount=5000, min_order_amount=None)
    assert promo_service.validate(db, "START20", user_id=user.id, order_total=3000).discount == 3000


def test_exhausted_code_rejected(db, user, other_user):
    code = make_code(db, max_redemptions=1)
    db.add(PromoRedemption(promo_id=code.id, user_id=other_user.id, lead_id=None,
                           discount_amount=5000, order_total=100000))
    db.commit()
    with pytest.raises(PromoError) as e:
        promo_service.validate(db, "START20", user_id=user.id, order_total=100000)
    assert "закончил" in str(e.value).lower()


def test_same_user_cannot_reuse(db, user):
    code = make_code(db)
    db.add(PromoRedemption(promo_id=code.id, user_id=user.id, lead_id=None,
                           discount_amount=5000, order_total=100000))
    db.commit()
    with pytest.raises(PromoError) as e:
        promo_service.validate(db, "START20", user_id=user.id, order_total=100000)
    assert "уже" in str(e.value).lower()


def test_unlimited_code_has_no_ceiling(db, user):
    make_code(db, max_redemptions=None)
    assert promo_service.validate(db, "START20", user_id=user.id, order_total=100000).discount == 5000


# ---------------- проверка НЕ тратит ----------------

def test_validate_does_not_consume(db, user):
    """Сердце сценария: сколько ни проверяй — расход нулевой."""
    code = make_code(db)
    for _ in range(5):
        promo_service.validate(db, "START20", user_id=user.id, order_total=100000)
    assert db.query(PromoRedemption).count() == 0
    assert promo_service.used_count(db, code.id) == 0


# ---------------- списание ----------------

def test_redeem_writes_journal(db, user):
    code = make_code(db)
    promo_service.redeem(db, code, user_id=user.id, lead_id=None,
                         discount=5000, order_total=100000)
    db.commit()
    rows = db.query(PromoRedemption).all()
    assert len(rows) == 1
    assert float(rows[0].discount_amount) == 5000
    assert float(rows[0].order_total) == 100000
    assert promo_service.used_count(db, code.id) == 1


def test_second_redeem_by_same_user_raises(db, user):
    """Гарантию даёт уникальный индекс, а не проверка перед вставкой."""
    code = make_code(db)
    promo_service.redeem(db, code, user_id=user.id, lead_id=None,
                         discount=5000, order_total=100000)
    db.commit()
    with pytest.raises(PromoError):
        promo_service.redeem(db, code, user_id=user.id, lead_id=None,
                             discount=5000, order_total=100000)
        db.commit()


def test_redeem_refuses_past_the_limit(db, user, other_user):
    code = make_code(db, max_redemptions=1)
    promo_service.redeem(db, code, user_id=other_user.id, lead_id=None,
                         discount=5000, order_total=100000)
    db.commit()
    with pytest.raises(PromoError):
        promo_service.redeem(db, code, user_id=user.id, lead_id=None,
                             discount=5000, order_total=100000)


def test_used_count_counts_only_this_code(db, user, other_user):
    a = make_code(db, code="AAA")
    b = make_code(db, code="BBB")
    promo_service.redeem(db, a, user_id=user.id, lead_id=None, discount=1, order_total=10)
    promo_service.redeem(db, b, user_id=other_user.id, lead_id=None, discount=1, order_total=10)
    db.commit()
    assert promo_service.used_count(db, a.id) == 1
    assert promo_service.used_count(db, b.id) == 1


# ------------------------------------------------- условия применения

def test_first_purchase_only_passes_for_a_newcomer(db, user):
    """«Только на первую покупку» — самый частый вид акции и единственный,
    который нельзя выразить порогом суммы."""
    promo = make_code(db, first_purchase_only=True)
    offer = promo_service.validate(db, promo.code, user_id=user.id, order_total=10_000)
    assert offer.discount == 5000


def test_first_purchase_only_rejected_for_a_returning_buyer(db, user):
    from app.services import loyalty

    make_code(db, first_purchase_only=True)
    loyalty.record(db, user_id=user.id, kind="purchase", amount=10_000,
                   comment="была покупка", idempotency_key="prev")
    db.commit()
    with pytest.raises(PromoError):
        promo_service.validate(db, "START20", user_id=user.id, order_total=10_000)


def test_category_condition_needs_such_an_item_in_the_cart(db, user):
    make_code(db, category="смартфоны")
    offer = promo_service.validate(
        db, "START20", user_id=user.id, order_total=10_000,
        items=[{"category": "смартфоны", "brand": "Apple"}])
    assert offer.discount == 5000

    with pytest.raises(PromoError):
        promo_service.validate(
            db, "START20", user_id=user.id, order_total=10_000,
            items=[{"category": "наушники", "brand": "Apple"}])


def test_brand_condition_is_case_insensitive(db, user):
    """Бренд в базе пишется как угодно, а в поле админки его набирают руками."""
    make_code(db, brand="Dyson")
    offer = promo_service.validate(
        db, "START20", user_id=user.id, order_total=10_000,
        items=[{"category": "красота", "brand": "dyson"}])
    assert offer.discount == 5000


def test_conditions_combine_as_and(db, user):
    """Два условия — это И, а не ИЛИ: код «на Dyson для новичков» обязан
    требовать оба, иначе он раздаёт скидку вдвое шире задуманного."""
    make_code(db, category="красота", brand="Dyson")
    with pytest.raises(PromoError):
        promo_service.validate(
            db, "START20", user_id=user.id, order_total=10_000,
            items=[{"category": "красота", "brand": "Apple"}])


def test_condition_failure_looks_like_an_unknown_code(db, user):
    """Разные тексты отказа превращают форму в проверялку чужих акций:
    по разнице сообщений подбирается список действующих кодов."""
    make_code(db, category="смартфоны")
    with pytest.raises(PromoError) as bad:
        promo_service.validate(db, "START20", user_id=user.id, order_total=10_000, items=[])
    with pytest.raises(PromoError) as missing:
        promo_service.validate(db, "NOSUCHCODE", user_id=user.id, order_total=10_000)
    assert str(bad.value) == str(missing.value)


def test_code_without_conditions_ignores_the_cart(db, user):
    """Старые коды продолжают работать без позиций — сигнатура расширена
    необязательным аргументом именно ради этого."""
    make_code(db)
    assert promo_service.validate(
        db, "START20", user_id=user.id, order_total=10_000).discount == 5000
