"""Корзина и общая заявка по ней (/api/cart).

Проверяем ровно то, что дороже всего сломать: владение, количество, актуальные
цены, недоступные товары, транзакционность checkout и идемпотентность. Плюс
регрессия: одиночные заявки продолжают работать без изменений.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.cart import MAX_CART_ITEMS, Cart, CartItem
from app.models.lead import Lead
from app.models.lead_item import LeadItem
from app.models.notification import Notification
from app.models.user import User
from app.services.availability import MAX_ITEM_QUANTITY
from tests.conftest import make_product


@pytest.fixture()
def ctx(db):
    """TestClient + два пользователя; текущего переключаем через holder['uid']."""
    u1 = User(telegram_id=101, first_name="U1", username="u1")
    u2 = User(telegram_id=202, first_name="U2", username="u2")
    db.add_all([u1, u2])
    db.commit()
    db.refresh(u1)
    db.refresh(u2)
    holder = {"uid": u1.id}

    def override_db():
        yield db

    def override_user():
        return db.get(User, holder["uid"])

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    try:
        yield TestClient(app), db, holder, u1, u2
    finally:
        app.dependency_overrides.clear()


def checkout_body(**kw) -> dict:
    body = {"phone": "+79990000000", "fulfillment_type": "pickup", "consent": True}
    body.update(kw)
    return body


# ============================================================ базовый цикл ====
def test_empty_cart_is_a_valid_state_not_an_error(ctx):
    client, *_ = ctx
    r = client.get("/api/cart")
    assert r.status_code == 200
    data = r.json()
    assert data["items"] == [] and data["items_count"] == 0
    assert data["estimated_total"] == 0.0
    assert data["cart_id"] is None  # корзина создаётся лениво, при добавлении


def test_add_update_remove_item(ctx):
    client, db, *_ = ctx
    p = make_product(db, title="iPhone 16", price=100000)

    data = client.post("/api/cart/items", json={"product_id": p.id}).json()
    assert data["positions_count"] == 1 and data["items_count"] == 1
    assert data["estimated_total"] == 100000.0
    item_id = data["items"][0]["id"]

    data = client.patch(f"/api/cart/items/{item_id}", json={"quantity": 3}).json()
    assert data["items"][0]["quantity"] == 3
    assert data["items_count"] == 3 and data["estimated_total"] == 300000.0

    data = client.delete(f"/api/cart/items/{item_id}").json()
    assert data["items"] == [] and data["estimated_total"] == 0.0


def test_adding_same_product_twice_increases_quantity(ctx):
    client, db, *_ = ctx
    p = make_product(db)
    client.post("/api/cart/items", json={"product_id": p.id})
    data = client.post("/api/cart/items", json={"product_id": p.id, "quantity": 2}).json()
    assert data["positions_count"] == 1
    assert data["items"][0]["quantity"] == 3
    assert db.query(CartItem).count() == 1  # дубля позиции нет


def test_quantity_zero_removes_position(ctx):
    """Шаг «−» на единице обязан убрать товар, а не оставить нулевое количество."""
    client, db, *_ = ctx
    p = make_product(db)
    item_id = client.post("/api/cart/items", json={"product_id": p.id}).json()["items"][0]["id"]
    data = client.patch(f"/api/cart/items/{item_id}", json={"quantity": 0}).json()
    assert data["items"] == []


def test_clear_cart(ctx):
    client, db, *_ = ctx
    for i in range(3):
        p = make_product(db, title=f"P{i}")
        client.post("/api/cart/items", json={"product_id": p.id})
    assert client.get("/api/cart").json()["positions_count"] == 3
    assert client.delete("/api/cart").json()["items"] == []
    # Сама корзина остаётся активной — новую заводить не нужно
    assert db.query(Cart).filter(Cart.status == "active").count() == 1


def test_clear_empty_cart_is_not_an_error(ctx):
    client, *_ = ctx
    assert client.delete("/api/cart").status_code == 200


def test_add_nonexistent_product_is_404(ctx):
    client, *_ = ctx
    assert client.post("/api/cart/items", json={"product_id": 999999}).status_code == 404


# ================================================================ владение ====
def test_cart_is_isolated_per_user(ctx):
    client, db, holder, u1, u2 = ctx
    p = make_product(db)
    holder["uid"] = u1.id
    client.post("/api/cart/items", json={"product_id": p.id})
    holder["uid"] = u2.id
    assert client.get("/api/cart").json()["items"] == []


def test_cannot_touch_another_users_item(ctx):
    client, db, holder, u1, u2 = ctx
    p = make_product(db)
    holder["uid"] = u1.id
    item_id = client.post("/api/cart/items", json={"product_id": p.id}).json()["items"][0]["id"]

    holder["uid"] = u2.id
    assert client.patch(f"/api/cart/items/{item_id}", json={"quantity": 5}).status_code == 404
    assert client.delete(f"/api/cart/items/{item_id}").status_code == 404

    holder["uid"] = u1.id  # чужие попытки ничего не изменили
    assert client.get("/api/cart").json()["items"][0]["quantity"] == 1


def test_cart_requires_authentication(db):
    """Без переопределения get_current_user маршрут обязан отдать 401."""
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    try:
        assert TestClient(app).get("/api/cart").status_code == 401
    finally:
        app.dependency_overrides.clear()


# ============================================================== количество ====
def test_quantity_capped_by_limited_stock(ctx):
    client, db, *_ = ctx
    p = make_product(db, is_limited=True, stock=2)
    item_id = client.post("/api/cart/items", json={"product_id": p.id, "quantity": 10}).json()["items"][0]["id"]
    data = client.get("/api/cart").json()
    assert data["items"][0]["quantity"] == 2 and data["items"][0]["max_quantity"] == 2
    assert client.patch(f"/api/cart/items/{item_id}", json={"quantity": 9}).json()["items"][0]["quantity"] == 2


def test_quantity_capped_by_global_limit(ctx):
    client, db, *_ = ctx
    p = make_product(db, stock=999)
    item_id = client.post("/api/cart/items", json={"product_id": p.id}).json()["items"][0]["id"]
    r = client.patch(f"/api/cart/items/{item_id}", json={"quantity": MAX_ITEM_QUANTITY + 5})
    assert r.status_code == 422  # схема отсекает раньше бизнес-логики


def test_cart_position_limit(ctx):
    client, db, *_ = ctx
    for i in range(MAX_CART_ITEMS):
        p = make_product(db, title=f"P{i}", sku=f"SKU{i}")
        assert client.post("/api/cart/items", json={"product_id": p.id}).status_code == 200
    overflow = make_product(db, title="51-й", sku="SKU-OVER")
    r = client.post("/api/cart/items", json={"product_id": overflow.id})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "cart_full"


# ============================================================ доступность ====
def test_out_of_stock_product_cannot_be_added(ctx):
    client, db, *_ = ctx
    p = make_product(db, availability_mode="out_of_stock")
    r = client.post("/api/cart/items", json={"product_id": p.id})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_orderable"


def test_inactive_product_cannot_be_added(ctx):
    client, db, *_ = ctx
    p = make_product(db, is_active=False)
    assert client.post("/api/cart/items", json={"product_id": p.id}).status_code == 409


def test_preorder_and_on_request_can_be_added(ctx):
    client, db, *_ = ctx
    pre = make_product(db, title="Предзаказ", sku="PRE", availability_mode="preorder")
    req = make_product(db, title="Под заказ", sku="REQ", in_stock=False, stock=0)
    assert client.post("/api/cart/items", json={"product_id": pre.id}).status_code == 200
    assert client.post("/api/cart/items", json={"product_id": req.id}).status_code == 200
    modes = {r["title"]: r["availability_mode"] for r in client.get("/api/cart").json()["items"]}
    assert modes == {"Предзаказ": "preorder", "Под заказ": "on_request"}


def test_product_becoming_inactive_is_flagged_and_excluded_from_total(ctx):
    client, db, *_ = ctx
    ok = make_product(db, title="Доступен", sku="OK", price=1000)
    gone = make_product(db, title="Скроют", sku="GONE", price=5000)
    client.post("/api/cart/items", json={"product_id": ok.id})
    client.post("/api/cart/items", json={"product_id": gone.id})

    gone.is_active = False
    db.commit()

    data = client.get("/api/cart").json()
    assert data["has_unavailable"] is True
    rows = {r["title"]: r for r in data["items"]}
    assert rows["Скроют"]["orderable"] is False and rows["Скроют"]["line_total"] == 0.0
    assert data["estimated_total"] == 1000.0  # недоступный товар в сумму не входит


def test_row_for_vanished_product_is_readable_not_a_crash(ctx):
    """Товара нет (удалён, гонка с админкой) — строка обязана остаться понятной.

    В PostgreSQL FK ON DELETE CASCADE уберёт позицию из живой корзины; здесь
    проверяется защитная ветка на случай, когда товар исчез между выборкой
    позиций и выборкой товаров.
    """
    client, db, *_ = ctx
    p = make_product(db, title="Удалят")
    client.post("/api/cart/items", json={"product_id": p.id})
    db.delete(p)
    db.commit()

    data = client.get("/api/cart").json()
    row = data["items"][0]
    assert row["orderable"] is False and row["line_total"] == 0.0
    assert row["title"] == "Товар удалён из каталога"
    assert data["estimated_total"] == 0.0 and data["has_unavailable"] is True


# ==================================================================== цены ====
def test_price_change_is_visible_and_total_uses_current_price(ctx):
    client, db, *_ = ctx
    p = make_product(db, price=100000)
    client.post("/api/cart/items", json={"product_id": p.id, "quantity": 2})

    p.price = 90000
    db.commit()

    data = client.get("/api/cart").json()
    row = data["items"][0]
    assert row["added_price"] == 100000.0 and row["price"] == 90000.0
    assert row["price_changed"] is True
    assert data["has_price_changes"] is True
    assert data["estimated_total"] == 180000.0  # 2 x актуальная цена


def test_unchanged_price_is_not_reported_as_changed(ctx):
    client, db, *_ = ctx
    p = make_product(db, price=100000)
    client.post("/api/cart/items", json={"product_id": p.id})
    assert client.get("/api/cart").json()["has_price_changes"] is False


# ================================================================ checkout ====
def test_checkout_creates_one_lead_with_all_items(ctx):
    client, db, *_ = ctx
    a = make_product(db, title="MacBook Air", sku="MBA", price=129990)
    b = make_product(db, title="AirPods Pro", sku="APP", price=16990)
    client.post("/api/cart/items", json={"product_id": a.id})
    client.post("/api/cart/items", json={"product_id": b.id, "quantity": 2})

    r = client.post("/api/cart/checkout", json=checkout_body(name="Гарик", comment="Позвоните вечером"))
    assert r.status_code == 201
    body = r.json()
    assert body["created"] is True

    lead = body["lead"]
    assert lead["lead_type"] == "cart"
    assert lead["source"] == "telegram_mini_app_cart"
    assert lead["status"] == "new"
    assert lead["delivery_method"] == "pickup"
    assert lead["items_count"] == 3           # 1 + 2 штуки
    assert lead["estimated_total"] == 129990 + 2 * 16990
    assert lead["public_number"] == f"№{lead['id']}"
    assert lead["name"] == "Гарик" and lead["message"] == "Позвоните вечером"

    titles = {i["title"]: i for i in lead["items"]}
    assert set(titles) == {"MacBook Air", "AirPods Pro"}
    assert titles["AirPods Pro"]["quantity"] == 2
    assert titles["AirPods Pro"]["line_total"] == 2 * 16990
    assert titles["AirPods Pro"]["sku"] == "APP"
    assert titles["MacBook Air"]["availability_mode"] == "in_stock"

    # Корзина закрыта, пользователь начинает с чистой
    assert body["cart"]["items"] == []
    assert db.query(Cart).filter(Cart.status == "converted").count() == 1


def test_checkout_notifies_manager(ctx, monkeypatch):
    client, db, *_ = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    p = make_product(db, title="MacBook Air", price=129990)
    client.post("/api/cart/items", json={"product_id": p.id})

    r = client.post("/api/cart/checkout", json=checkout_body())
    assert r.status_code == 201

    notif = db.query(Notification).filter_by(kind="new_lead").first()
    assert notif is not None
    assert "MacBook Air" in notif.text or "1 товар" in notif.text


def test_repeat_checkout_with_same_idempotency_key_does_not_double_notify(ctx, monkeypatch):
    client, db, *_ = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    p = make_product(db, price=5000)
    client.post("/api/cart/items", json={"product_id": p.id})

    body = checkout_body(idempotency_key="abc123")
    first = client.post("/api/cart/checkout", json=body)
    assert first.json()["created"] is True

    # Вторая корзина того же пользователя, тот же ключ идемпотентности:
    # cart_service.checkout вернёт СУЩЕСТВУЮЩУЮ заявку, created=False.
    client.post("/api/cart/items", json={"product_id": p.id})
    second = client.post("/api/cart/checkout", json=body)
    assert second.json()["created"] is False

    assert db.query(Notification).filter_by(kind="new_lead").count() == 1


def test_cart_lead_metadata_has_no_untranslated_keys(ctx):
    """metadata заявки рисуется в UI как «подпись: значение», и незнакомый ключ
    выводится сырым. Поэтому в metadata заявки-корзины допустим только origin —
    он в списке скрытых. Любой новый ключ обязан получить русскую подпись
    в lib/leads.ts и admin/ui.ts, иначе менеджер увидит «positions: 3»."""
    client, db, *_ = ctx
    p = make_product(db)
    client.post("/api/cart/items", json={"product_id": p.id})
    lead = client.post("/api/cart/checkout", json=checkout_body()).json()["lead"]
    assert set(lead["metadata"].keys()) == {"origin"}
    assert lead["metadata"]["origin"] == "cart"


def test_checkout_of_single_item_cart(ctx):
    client, db, *_ = ctx
    p = make_product(db, price=5000)
    client.post("/api/cart/items", json={"product_id": p.id})
    lead = client.post("/api/cart/checkout", json=checkout_body()).json()["lead"]
    assert len(lead["items"]) == 1 and lead["estimated_total"] == 5000


def test_checkout_snapshots_survive_price_change(ctx):
    """Снапшот — то, что отправил покупатель. Каталог потом живёт своей жизнью."""
    client, db, *_ = ctx
    p = make_product(db, price=1000)
    client.post("/api/cart/items", json={"product_id": p.id})
    lead_id = client.post("/api/cart/checkout", json=checkout_body()).json()["lead"]["id"]

    p.price = 2000
    p.title = "Переименован"
    db.commit()

    item = db.query(LeadItem).filter(LeadItem.lead_id == lead_id).one()
    assert float(item.price_snapshot) == 1000.0
    assert item.title_snapshot != "Переименован"


def test_checkout_uses_current_price_not_added_price(ctx):
    client, db, *_ = ctx
    p = make_product(db, price=1000)
    client.post("/api/cart/items", json={"product_id": p.id})
    p.price = 1500
    db.commit()
    lead = client.post("/api/cart/checkout", json=checkout_body()).json()["lead"]
    assert lead["estimated_total"] == 1500.0
    assert lead["items"][0]["price"] == 1500.0


def test_checkout_of_empty_cart_is_rejected(ctx):
    client, *_ = ctx
    r = client.post("/api/cart/checkout", json=checkout_body())
    assert r.status_code == 400 and r.json()["detail"]["code"] == "empty_cart"


def test_checkout_blocked_when_item_became_unavailable_and_cart_survives(ctx):
    """Провалившийся checkout НЕ имеет права очистить корзину: пользователь
    должен вернуться к своему списку и решить, что делать."""
    client, db, *_ = ctx
    ok = make_product(db, title="OK", sku="OK", price=1000)
    bad = make_product(db, title="BAD", sku="BAD", price=2000)
    client.post("/api/cart/items", json={"product_id": ok.id})
    client.post("/api/cart/items", json={"product_id": bad.id})

    bad.is_active = False
    db.commit()

    r = client.post("/api/cart/checkout", json=checkout_body())
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "items_unavailable"
    assert [i["product_id"] for i in detail["items"]] == [bad.id]

    assert db.query(Lead).count() == 0
    assert client.get("/api/cart").json()["positions_count"] == 2  # корзина цела


def test_checkout_requires_consent(ctx):
    client, db, *_ = ctx
    p = make_product(db)
    client.post("/api/cart/items", json={"product_id": p.id})
    r = client.post("/api/cart/checkout", json=checkout_body(consent=False))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "consent_required"
    assert db.query(Lead).count() == 0


def test_phone_required_only_without_telegram_username(ctx):
    client, db, holder, u1, _u2 = ctx
    p = make_product(db)
    client.post("/api/cart/items", json={"product_id": p.id})

    u1.username = None  # менеджеру некуда ответить в Telegram
    db.commit()
    r = client.post("/api/cart/checkout", json=checkout_body(phone=""))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "phone_required"

    u1.username = "garik"
    db.commit()
    assert client.post("/api/cart/checkout", json=checkout_body(phone="")).status_code == 201


def test_unknown_fulfillment_falls_back_to_consult(ctx):
    client, db, *_ = ctx
    p = make_product(db)
    client.post("/api/cart/items", json={"product_id": p.id})
    lead = client.post("/api/cart/checkout", json=checkout_body(fulfillment_type="teleport")).json()["lead"]
    assert lead["delivery_method"] == "consult"


def test_limited_quantity_reclamped_at_checkout(ctx):
    """Партия уменьшилась после добавления — в заявку уходит реальный лимит."""
    client, db, *_ = ctx
    p = make_product(db, is_limited=True, stock=5, price=1000)
    client.post("/api/cart/items", json={"product_id": p.id, "quantity": 5})
    p.stock = 2
    db.commit()
    lead = client.post("/api/cart/checkout", json=checkout_body()).json()["lead"]
    assert lead["items"][0]["quantity"] == 2
    assert lead["estimated_total"] == 2000.0


# ========================================================= идемпотентность ====
def test_repeated_checkout_with_same_key_returns_same_lead(ctx):
    client, db, *_ = ctx
    p = make_product(db, price=1000)
    client.post("/api/cart/items", json={"product_id": p.id})

    first = client.post("/api/cart/checkout", json=checkout_body(idempotency_key="abc-123")).json()
    second = client.post("/api/cart/checkout", json=checkout_body(idempotency_key="abc-123")).json()

    assert first["created"] is True and second["created"] is False
    assert first["lead"]["id"] == second["lead"]["id"]
    assert db.query(Lead).count() == 1
    assert db.query(LeadItem).count() == 1


def test_double_submit_without_key_would_fail_on_empty_cart(ctx):
    """Без ключа вторая отправка не может продублировать заявку по другой
    причине: корзина уже закрыта, отправлять нечего."""
    client, db, *_ = ctx
    p = make_product(db)
    client.post("/api/cart/items", json={"product_id": p.id})
    assert client.post("/api/cart/checkout", json=checkout_body()).status_code == 201
    assert client.post("/api/cart/checkout", json=checkout_body()).status_code == 400
    assert db.query(Lead).count() == 1


def test_idempotency_key_is_scoped_to_user(ctx):
    """Одинаковый ключ у разных пользователей — две РАЗНЫЕ заявки.

    Глобально уникальный ключ означал бы, что чужой клиент, отправив то же
    значение, ломает checkout соседу (или получает его заявку в ответ).
    """
    client, db, holder, u1, u2 = ctx
    p = make_product(db)

    holder["uid"] = u1.id
    client.post("/api/cart/items", json={"product_id": p.id})
    first = client.post("/api/cart/checkout", json=checkout_body(idempotency_key="shared-key"))

    holder["uid"] = u2.id
    client.post("/api/cart/items", json={"product_id": p.id})
    second = client.post("/api/cart/checkout", json=checkout_body(idempotency_key="shared-key"))

    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["lead"]["id"] != second.json()["lead"]["id"]
    assert second.json()["created"] is True
    assert db.query(Lead).count() == 2


# ================================================== регрессия старых заявок ====
def test_old_single_product_lead_still_works(ctx):
    client, db, *_ = ctx
    p = make_product(db, title="iPhone", price=99990)
    r = client.post("/api/leads", json={
        "phone": "+79990000000", "product_id": p.id, "source": "product", "message": "Хочу",
    })
    assert r.status_code == 201
    lead = r.json()
    assert lead["lead_type"] == "general"
    assert lead["product_title"] == "iPhone"
    # Новые поля присутствуют и пусты — старый клиент их просто игнорирует
    assert lead["items"] == [] and lead["items_count"] == 0
    assert lead["estimated_total"] is None


def test_my_leads_returns_both_kinds(ctx):
    client, db, *_ = ctx
    p = make_product(db, price=1000)
    client.post("/api/leads", json={"phone": "+7999", "product_id": p.id, "source": "product"})
    client.post("/api/cart/items", json={"product_id": p.id})
    client.post("/api/cart/checkout", json=checkout_body())

    leads = client.get("/api/leads/my").json()["leads"]
    assert len(leads) == 2
    kinds = {l["lead_type"] for l in leads}
    assert kinds == {"general", "cart"}
    cart_lead = next(l for l in leads if l["lead_type"] == "cart")
    assert len(cart_lead["items"]) == 1
