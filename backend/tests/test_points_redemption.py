"""Списание баллов в корзине.

Главное, что здесь держится: баллы и промокод взаимоисключающи, списать больше
разрешённой доли чека нельзя, а отменённая заявка возвращает баллы — ровно один
раз, сколько бы раз её ни отменяли.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.lead import Lead
from app.models.loyalty_settings import LoyaltySettings  # noqa: F401  — регистрирует таблицу
from app.models.promo import PromoCode
from app.models.user import User
from app.services import cart as cart_service
from app.services import loyalty
from tests.conftest import make_product


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=930, first_name="Гриша", username="grisha")
    db.add(u)
    db.commit()
    db.refresh(u)
    product = make_product(db, title="iPhone 17", price=100_000)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, product, u
    finally:
        app.dependency_overrides.clear()


def _give(db, user, points: int) -> None:
    loyalty.record(db, user_id=user.id, kind="bonus", points=points,
                   comment="для теста", idempotency_key=f"seed-{user.id}-{points}")
    db.commit()


def _fill(client, product_id, quantity=1):
    r = client.post("/api/cart/items", json={"product_id": product_id, "quantity": quantity})
    assert r.status_code == 200, r.text
    return r.json()


def _checkout(client, **kw):
    body = {"phone": "+79990000000", "consent": True, "fulfillment_type": "pickup"}
    body.update(kw)
    return client.post("/api/cart/checkout", json=body)


# ---------------- сколько вообще можно списать ----------------

def test_redeemable_is_limited_by_the_share_of_the_order(ctx):
    """Доля чека, а не весь баланс: при марже около 5,5% списание в 10% —
    продажа в убыток, поэтому предел настраивается и по умолчанию 5%."""
    _client, db, _p, user = ctx
    _give(db, user, 50_000)
    # 5% от 100 000 = 5 000, хотя на счету 50 000.
    assert cart_service.redeemable(db, user.id, 100_000) == 5_000


def test_redeemable_is_limited_by_the_balance(ctx):
    _client, db, _p, user = ctx
    _give(db, user, 300)
    assert cart_service.redeemable(db, user.id, 100_000) == 300


def test_redeemable_is_never_negative(ctx):
    _client, db, _p, user = ctx
    assert cart_service.redeemable(db, user.id, 0) == 0
    assert cart_service.redeemable(db, user.id, 100_000) == 0


def test_share_comes_from_settings(ctx):
    _client, db, _p, user = ctx
    _give(db, user, 50_000)
    db.add(LoyaltySettings(id=1, redeem_max_bps=1000))   # 10%
    db.commit()
    assert cart_service.redeemable(db, user.id, 100_000) == 10_000


# ---------------- оформление со списанием ----------------

def test_checkout_spends_points_and_lowers_the_total(ctx):
    client, db, product, user = ctx
    _give(db, user, 10_000)
    _fill(client, product.id)

    resp = _checkout(client, points_to_spend=5_000)
    assert resp.status_code == 201, resp.text

    lead = db.query(Lead).one()
    assert float(lead.estimated_total) == 95_000
    assert lead.meta.get("points_spent") == 5_000
    # Баланс уменьшился ровно на списанное.
    assert loyalty.summary(db, user.id)["balance"] == 5_000


def test_spending_more_than_allowed_is_refused(ctx):
    client, db, product, user = ctx
    _give(db, user, 50_000)
    _fill(client, product.id)

    resp = _checkout(client, points_to_spend=5_001)   # 5% от 100 000 = 5 000
    assert resp.status_code == 400
    assert db.query(Lead).count() == 0
    # Баланс не тронут: отказ не имеет права списать «частично».
    assert loyalty.summary(db, user.id)["balance"] == 50_000


def test_points_and_promo_cannot_be_combined(ctx):
    """Решение владельца: взаимоисключающи. Молча проигнорировать второе нельзя —
    человек должен видеть причину, иначе это выглядит как поломка."""
    client, db, product, user = ctx
    _give(db, user, 10_000)
    db.add(PromoCode(code="START20", discount_amount=5000, is_active=True))
    db.commit()
    _fill(client, product.id)

    resp = _checkout(client, points_to_spend=1_000, promo_code="START20")
    assert resp.status_code == 400
    body = resp.json()["detail"]
    assert body["code"] == "points_and_promo"
    assert "промокод" in body["detail"].lower()
    assert db.query(Lead).count() == 0


def test_checkout_without_points_is_unchanged(ctx):
    client, db, product, user = ctx
    _fill(client, product.id)
    assert _checkout(client).status_code == 201
    lead = db.query(Lead).one()
    assert float(lead.estimated_total) == 100_000
    assert lead.meta.get("points_spent") in (None, 0)


# ---------------- возврат ----------------

def test_cancelling_returns_the_points(ctx):
    client, db, product, user = ctx
    _give(db, user, 10_000)
    _fill(client, product.id)
    _checkout(client, points_to_spend=5_000)
    lead = db.query(Lead).one()
    assert loyalty.summary(db, user.id)["balance"] == 5_000

    assert client.post(f"/api/leads/{lead.id}/cancel").status_code == 200
    assert loyalty.summary(db, user.id)["balance"] == 10_000


def test_manager_cancelling_returns_the_points_too(ctx):
    """Отменить может и менеджер — возврат обязан работать с обеих сторон."""
    client, db, product, user = ctx
    _give(db, user, 10_000)
    _fill(client, product.id)
    _checkout(client, points_to_spend=5_000)
    lead = db.query(Lead).one()

    resp = client.patch(f"/api/admin/leads/{lead.id}", json={"status": "cancelled"})
    assert resp.status_code == 200, resp.text
    assert loyalty.summary(db, user.id)["balance"] == 10_000


def test_refund_happens_only_once(ctx):
    """Идемпотентность возврата держит ключ, а не осторожность вызывающего:
    повторная отмена не имеет права подарить баллы второй раз."""
    client, db, product, user = ctx
    _give(db, user, 10_000)
    _fill(client, product.id)
    _checkout(client, points_to_spend=5_000)
    lead = db.query(Lead).one()

    client.post(f"/api/leads/{lead.id}/cancel")
    client.patch(f"/api/admin/leads/{lead.id}", json={"status": "cancelled"})
    assert loyalty.summary(db, user.id)["balance"] == 10_000


def test_cancelling_a_lead_without_points_changes_nothing(ctx):
    client, db, product, user = ctx
    _fill(client, product.id)
    _checkout(client)
    lead = db.query(Lead).one()
    client.post(f"/api/leads/{lead.id}/cancel")
    assert loyalty.summary(db, user.id)["balance"] == 0


# ---------------- то, что видит корзина ----------------

def test_cart_tells_how_much_can_be_spent(ctx):
    """Число считает сервер: доля чека и баланс живут там же, где правило."""
    client, db, product, user = ctx
    _give(db, user, 10_000)
    _fill(client, product.id)

    payload = client.get("/api/cart").json()
    assert payload["points_balance"] == 10_000
    assert payload["points_redeemable"] == 5_000
