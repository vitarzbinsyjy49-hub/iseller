"""Заявки-корзины в админке.

Самое дорогое требование релиза: пользователь получил «отправлено» — менеджер
ОБЯЗАН это увидеть. Поэтому здесь проверяются не только новые поля, но и то,
что заявка попала в общий список, в дашборд, в фильтр «Новые» и в источники
аналитики, а старые одиночные заявки от этого не пострадали.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User
from tests.conftest import make_product


@pytest.fixture()
def ctx(db):
    """Один клиент, у которого есть и пользовательские, и админские права:
    заявку создаём как покупатель, смотрим как менеджер."""
    user = User(telegram_id=777, first_name="Гарик", username="garik")
    db.add(user)
    db.commit()
    db.refresh(user)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, user
    finally:
        app.dependency_overrides.clear()


def submit_cart(client, db, products: list[tuple], **kw):
    """Положить товары в корзину и отправить заявку. products: [(product, qty)]."""
    for product, qty in products:
        client.post("/api/cart/items", json={"product_id": product.id, "quantity": qty})
    body = {"phone": "+79990000000", "fulfillment_type": "delivery", "consent": True,
            "name": "Гарик", "comment": "Позвоните после 18"}
    body.update(kw)
    return client.post("/api/cart/checkout", json=body).json()["lead"]


def test_cart_lead_appears_in_admin_list_with_totals(ctx):
    client, db, _user = ctx
    a = make_product(db, title="MacBook Air", sku="MBA", price=129990)
    b = make_product(db, title="AirPods Pro", sku="APP", price=16990)
    lead = submit_cart(client, db, [(a, 1), (b, 2)])

    rows = client.get("/api/admin/leads").json()["leads"]
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == lead["id"]
    assert row["lead_type"] == "cart"
    assert row["source"] == "telegram_mini_app_cart"
    assert row["items_count"] == 3
    assert row["estimated_total"] == 129990 + 2 * 16990
    assert row["currency"] == "RUB"
    assert row["delivery_method"] == "delivery"
    assert row["phone"] == "+79990000000" and row["username"] == "garik"
    assert len(row["items"]) == 2


def test_admin_can_filter_cart_leads_by_type_and_source(ctx):
    client, db, _user = ctx
    p = make_product(db, price=1000)
    client.post("/api/leads", json={"phone": "+7999", "product_id": p.id, "source": "product"})
    submit_cart(client, db, [(p, 1)])

    assert len(client.get("/api/admin/leads").json()["leads"]) == 2
    cart_only = client.get("/api/admin/leads?type_filter=cart").json()["leads"]
    assert len(cart_only) == 1 and cart_only[0]["lead_type"] == "cart"
    by_source = client.get("/api/admin/leads?source_filter=telegram_mini_app_cart").json()["leads"]
    assert len(by_source) == 1


def test_lead_detail_shows_snapshot_and_current_price_side_by_side(ctx):
    client, db, _user = ctx
    p = make_product(db, title="iPhone", sku="IP", price=100000)
    lead = submit_cart(client, db, [(p, 1)])

    p.price = 120000          # цена в каталоге выросла после заявки
    p.title = "iPhone (новый год)"
    db.commit()

    data = client.get(f"/api/admin/leads/{lead['id']}").json()
    item = data["items"][0]
    assert item["price"] == 100000.0            # снапшот неизменен
    assert item["current_price"] == 120000.0    # актуальная рядом
    assert item["price_diff"] == 20000.0
    assert item["title"] == "iPhone"
    assert item["current_title"] == "iPhone (новый год)"
    assert item["product_exists"] is True and item["product_active"] is True


def test_lead_detail_survives_deleted_product(ctx):
    """Товар удалили — заявка обязана остаться читаемой целиком."""
    client, db, _user = ctx
    p = make_product(db, title="Исчезнет", sku="GONE", price=5000)
    lead = submit_cart(client, db, [(p, 2)])
    db.delete(p)
    db.commit()

    data = client.get(f"/api/admin/leads/{lead['id']}").json()
    item = data["items"][0]
    assert item["title"] == "Исчезнет" and item["price"] == 5000.0
    assert item["quantity"] == 2 and item["line_total"] == 10000.0
    assert item["product_exists"] is False
    assert item["current_price"] is None
    assert data["estimated_total"] == 10000.0


def test_lead_detail_404_for_unknown_lead(ctx):
    client, *_ = ctx
    assert client.get("/api/admin/leads/999999").status_code == 404


def test_manager_changes_status_including_new_cart_statuses(ctx):
    client, db, _user = ctx
    p = make_product(db)
    lead = submit_cart(client, db, [(p, 1)])
    for status_value in ("contacted", "confirming", "confirmed", "completed"):
        r = client.patch(f"/api/admin/leads/{lead['id']}", json={"status": status_value})
        assert r.status_code == 200 and r.json()["status"] == status_value


def test_unknown_status_is_rejected(ctx):
    client, db, _user = ctx
    p = make_product(db)
    lead = submit_cart(client, db, [(p, 1)])
    assert client.patch(f"/api/admin/leads/{lead['id']}", json={"status": "shipped"}).status_code == 400


def test_status_change_does_not_touch_item_snapshots(ctx):
    """Менеджер меняет статус — состав и цены заявки остаются как были."""
    client, db, _user = ctx
    p = make_product(db, price=7000)
    lead = submit_cart(client, db, [(p, 3)])
    client.patch(f"/api/admin/leads/{lead['id']}", json={"status": "confirmed"})
    data = client.get(f"/api/admin/leads/{lead['id']}").json()
    assert data["items"][0]["price"] == 7000.0 and data["items"][0]["quantity"] == 3
    assert data["estimated_total"] == 21000.0


def test_dashboard_and_analytics_count_cart_leads(ctx):
    client, db, _user = ctx
    p = make_product(db, price=1000)
    client.post("/api/leads", json={"phone": "+7999", "product_id": p.id, "source": "product"})
    submit_cart(client, db, [(p, 1)])

    dash = client.get("/api/admin/dashboard").json()
    assert dash["leads_total"] == 2          # общий счётчик включает корзину
    assert dash["leads_today"] == 2
    assert dash["cart_leads_total"] == 1
    assert any(l["lead_type"] == "cart" for l in dash["recent_leads"])

    analytics = client.get("/api/admin/analytics").json()
    sources = {s["source"]: s["count"] for s in analytics["lead_sources"]}
    assert sources["telegram_mini_app_cart"] == 1
    assert sources["product"] == 1


def test_new_filter_includes_cart_leads(ctx):
    client, db, _user = ctx
    p = make_product(db)
    submit_cart(client, db, [(p, 1)])
    rows = client.get("/api/admin/leads?status_filter=new").json()["leads"]
    assert len(rows) == 1 and rows[0]["lead_type"] == "cart"


def test_old_single_lead_detail_still_renders(ctx):
    """Регрессия: у одиночной заявки позиций нет — деталка не должна падать."""
    client, db, _user = ctx
    p = make_product(db, title="iPhone", price=99990)
    created = client.post("/api/leads", json={
        "phone": "+79990000000", "product_id": p.id, "source": "product",
    }).json()

    data = client.get(f"/api/admin/leads/{created['id']}").json()
    assert data["items"] == []
    assert data["items_count"] == 0 and data["estimated_total"] is None
    assert data["product_title"] == "iPhone" and data["product_price"] == 99990.0


def test_availability_mode_is_editable_from_admin(ctx):
    client, db, _user = ctx
    p = make_product(db)
    r = client.patch(f"/api/admin/products/{p.id}", json={"availability_mode": "preorder"})
    assert r.status_code == 200 and r.json()["availability_mode"] == "preorder"

    # Пустая строка возвращает товар к выводу из флагов
    r = client.patch(f"/api/admin/products/{p.id}", json={"availability_mode": ""})
    assert r.json()["availability_mode"] is None

    # Мусор не сохраняем: неизвестный режим резолвер не знает
    r = client.patch(f"/api/admin/products/{p.id}", json={"availability_mode": "на_витрине"})
    assert r.json()["availability_mode"] is None
