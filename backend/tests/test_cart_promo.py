"""Промокод в корзине: превью не тратит, оформление тратит.

Отдельный файл от test_promo.py: там правила самого кода, здесь — их стык с
корзиной и заявкой. Именно на этом стыке живёт требование владельца: купон
достаётся тем, кто оформил заявку, а не тем, кто ввёл код.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.lead import Lead
from app.models.promo import PromoCode, PromoRedemption
from app.models.user import User
from tests.conftest import make_product


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=910, first_name="Гриша", username="grisha")
    db.add(u)
    db.commit()
    db.refresh(u)
    product = make_product(db, title="iPhone 17", price=100000)
    db.add(PromoCode(code="START20", discount_amount=5000, max_redemptions=20, is_active=True))
    db.commit()

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    try:
        yield TestClient(app), db, product, u
    finally:
        app.dependency_overrides.clear()


def _fill_cart(client, product_id, quantity=1):
    r = client.post("/api/cart/items", json={"product_id": product_id, "quantity": quantity})
    assert r.status_code == 200
    return r.json()


def _checkout(client, **kw):
    body = {"phone": "+79990000000", "consent": True, "fulfillment_type": "pickup"}
    body.update(kw)
    return client.post("/api/cart/checkout", json=body)


# ---------------- превью ----------------

def test_preview_returns_discount_and_total(ctx):
    client, _db, product, _u = ctx
    _fill_cart(client, product.id)
    r = client.post("/api/cart/promo", json={"code": "start20"})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "START20"
    assert body["discount"] == 5000
    assert body["subtotal"] == 100000
    assert body["total"] == 95000


def test_preview_does_not_consume(ctx):
    """Сердце требования: сколько ни вводи — расход нулевой."""
    client, db, product, _u = ctx
    _fill_cart(client, product.id)
    for _ in range(5):
        assert client.post("/api/cart/promo", json={"code": "START20"}).status_code == 200
    assert db.query(PromoRedemption).count() == 0


def test_preview_rejects_unknown_code(ctx):
    client, _db, product, _u = ctx
    _fill_cart(client, product.id)
    r = client.post("/api/cart/promo", json={"code": "NOSUCH"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "promo_invalid"


def test_preview_on_empty_cart_rejected(ctx):
    """Скидка «на ничего» — бессмысленный ответ, который потом придётся объяснять."""
    client, _db, _product, _u = ctx
    r = client.post("/api/cart/promo", json={"code": "START20"})
    assert r.status_code == 400


# ---------------- оформление ----------------

def test_checkout_applies_discount_to_lead(ctx):
    client, db, product, _u = ctx
    _fill_cart(client, product.id)
    r = _checkout(client, promo_code="start20", idempotency_key="k1")
    assert r.status_code == 201
    lead = r.json()["lead"]
    # Итог заявки — сумма СО скидкой: это то, что покупателю обещали на экране.
    assert lead["estimated_total"] == 95000
    assert lead["metadata"]["promo_code"] == "START20"
    assert lead["metadata"]["promo_discount"] == 5000
    assert lead["metadata"]["subtotal"] == 100000

    rows = db.query(PromoRedemption).all()
    assert len(rows) == 1
    assert rows[0].lead_id == lead["id"]
    assert float(rows[0].discount_amount) == 5000
    assert float(rows[0].order_total) == 100000


def test_checkout_without_code_unchanged(ctx):
    """Заявки без промокода обязаны вести себя ровно как раньше."""
    client, db, product, _u = ctx
    _fill_cart(client, product.id)
    r = _checkout(client, idempotency_key="k2")
    assert r.status_code == 201
    lead = r.json()["lead"]
    assert lead["estimated_total"] == 100000
    assert "promo_code" not in lead["metadata"]
    assert db.query(PromoRedemption).count() == 0


def test_checkout_with_bad_code_creates_nothing(ctx):
    """Кривой код НЕ должен молча пропустить заявку по полной цене: человек
    рассчитывал на скидку и обязан узнать, что её не будет."""
    client, db, product, _u = ctx
    _fill_cart(client, product.id)
    r = _checkout(client, promo_code="NOSUCH", idempotency_key="k3")
    assert r.status_code == 400
    assert db.query(Lead).count() == 0
    assert db.query(PromoRedemption).count() == 0


def test_second_checkout_by_same_user_refuses_code(ctx):
    client, db, product, _u = ctx
    _fill_cart(client, product.id)
    assert _checkout(client, promo_code="START20", idempotency_key="k4").status_code == 201

    _fill_cart(client, product.id)
    r = _checkout(client, promo_code="START20", idempotency_key="k5")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "promo_invalid"
    assert db.query(PromoRedemption).count() == 1


def test_repeat_of_same_checkout_does_not_double_spend(ctx):
    """Повтор по тому же ключу идемпотентности возвращает ту же заявку и НЕ
    списывает купон второй раз."""
    client, db, product, _u = ctx
    _fill_cart(client, product.id)
    first = _checkout(client, promo_code="START20", idempotency_key="same")
    second = _checkout(client, promo_code="START20", idempotency_key="same")
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["lead"]["id"] == second.json()["lead"]["id"]
    assert db.query(PromoRedemption).count() == 1


def test_discount_capped_by_cart_total(ctx):
    client, db, product, _u = ctx
    cheap = make_product(db, title="Чехол", price=3000)
    _fill_cart(client, cheap.id)
    r = _checkout(client, promo_code="START20", idempotency_key="k6")
    assert r.status_code == 201
    lead = r.json()["lead"]
    assert lead["estimated_total"] == 0
    assert lead["metadata"]["promo_discount"] == 3000
