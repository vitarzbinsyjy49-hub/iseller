"""Тесты управления товарами (v5.2.1): bulk-action, безопасное удаление, поиск.

Контракт:
- POST   /api/admin/products/bulk-action  {product_ids, action}
- DELETE /api/admin/products/{id}          физическое удаление с проверкой связей
- GET    /api/admin/products?q=&page=&page_size=  поиск (title+sku) + пагинация

Удаление блокируется ТОЛЬКО заявками (Lead.product_id): аналитика — сырой лог,
посты не ссылаются на товар в схеме. В bulk-delete заблокированный товар
скрывается (is_active=false), а не удаляется.
"""
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import admin_crm
from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.audit import AuditLog
from app.models.lead import Lead
from app.models.product import Product
from tests.conftest import make_product


@pytest.fixture()
def client(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def forbidden_client(db):
    """Клиент без прав администратора: get_current_admin отдаёт 403."""
    def override_db():
        yield db

    def forbidden():
        raise HTTPException(status_code=403, detail="Admin access required")

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = forbidden
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _add_lead(db, product: Product) -> Lead:
    lead = Lead(product_id=product.id, product_title=product.title, source="product", status="new")
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


# ==================== bulk-action: обычные действия ====================

def test_admin_can_deactivate_product(client, db):
    p = make_product(db, is_active=True)
    r = client.post("/api/admin/products/bulk-action",
                    json={"product_ids": [p.id], "action": "deactivate"})
    assert r.status_code == 200
    assert r.json()["updated"] == 1
    db.refresh(p)
    assert p.is_active is False


def test_bulk_deactivate(client, db):
    ids = [make_product(db, is_active=True).id for _ in range(3)]
    r = client.post("/api/admin/products/bulk-action",
                    json={"product_ids": ids, "action": "deactivate"})
    assert r.status_code == 200
    assert r.json()["updated"] == 3
    for pid in ids:
        assert db.get(Product, pid).is_active is False


def test_bulk_activate(client, db):
    ids = [make_product(db, is_active=False).id for _ in range(2)]
    r = client.post("/api/admin/products/bulk-action",
                    json={"product_ids": ids, "action": "activate"})
    assert r.status_code == 200
    assert r.json()["updated"] == 2
    for pid in ids:
        assert db.get(Product, pid).is_active is True


def test_bulk_set_out_of_stock(client, db):
    p = make_product(db, stock=10, in_stock=True, is_available_today=True)
    r = client.post("/api/admin/products/bulk-action",
                    json={"product_ids": [p.id], "action": "set_out_of_stock"})
    assert r.status_code == 200
    db.refresh(p)
    assert p.stock == 0
    assert p.is_available_today is False
    assert p.in_stock is False


def test_bulk_action_rejects_unknown_action(client, db):
    p = make_product(db)
    r = client.post("/api/admin/products/bulk-action",
                    json={"product_ids": [p.id], "action": "nuke"})
    assert r.status_code == 400


def test_bulk_action_rejects_empty_ids(client):
    r = client.post("/api/admin/products/bulk-action",
                    json={"product_ids": [], "action": "deactivate"})
    assert r.status_code == 400


# ==================== удаление ====================

def test_delete_product_without_relations(client, db):
    p = make_product(db)
    pid = p.id
    r = client.delete(f"/api/admin/products/{pid}")
    assert r.status_code == 200
    assert r.json()["deleted"] is True
    assert db.get(Product, pid) is None


def test_delete_product_with_lead_is_blocked(client, db):
    p = make_product(db)
    _add_lead(db, p)
    r = client.delete(f"/api/admin/products/{p.id}")
    assert r.status_code == 409
    # товар остаётся в базе — молча не удаляем
    assert db.get(Product, p.id) is not None


def test_delete_nonexistent_id(client, db):
    r = client.delete("/api/admin/products/999999")
    assert r.status_code == 404


def test_non_admin_cannot_delete(forbidden_client, db):
    p = make_product(db)
    r = forbidden_client.delete(f"/api/admin/products/{p.id}")
    assert r.status_code == 403
    assert db.get(Product, p.id) is not None


def test_non_admin_cannot_bulk_action(forbidden_client, db):
    p = make_product(db)
    r = forbidden_client.post("/api/admin/products/bulk-action",
                              json={"product_ids": [p.id], "action": "delete"})
    assert r.status_code == 403


# ==================== bulk delete: удалено / скрыто / пропущено ====================

def test_bulk_delete_mixed(client, db):
    """7 без связей удаляются, 2 со связями скрываются, 1 несуществующий пропущен."""
    free_ids = [make_product(db).id for _ in range(7)]
    blocked = [make_product(db) for _ in range(2)]
    for p in blocked:
        _add_lead(db, p)
    blocked_ids = [p.id for p in blocked]
    ids = free_ids + blocked_ids + [999999]

    r = client.post("/api/admin/products/bulk-action",
                    json={"product_ids": ids, "action": "delete"})
    assert r.status_code == 200
    data = r.json()
    assert data["deleted"] == 7
    assert data["hidden"] == 2
    assert data["skipped"] == 1

    for pid in free_ids:
        assert db.get(Product, pid) is None
    for pid in blocked_ids:
        prod = db.get(Product, pid)
        assert prod is not None and prod.is_active is False


def test_bulk_delete_runs_in_single_transaction_and_rolls_back(client, db, monkeypatch):
    """Ошибка на середине пакета откатывает уже удалённые товары целиком."""
    p1 = make_product(db)
    p2 = make_product(db)

    calls = {"n": 0}
    original = admin_crm.product_delete_blockers

    def flaky(session, product_id):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise RuntimeError("boom during bulk delete")
        return original(session, product_id)

    monkeypatch.setattr(admin_crm, "product_delete_blockers", flaky)

    r = client.post("/api/admin/products/bulk-action",
                    json={"product_ids": [p1.id, p2.id], "action": "delete"})
    assert r.status_code == 500
    # оба товара на месте — транзакция откатилась
    assert db.get(Product, p1.id) is not None
    assert db.get(Product, p2.id) is not None
    # аудит тоже откатился
    assert db.query(AuditLog).filter(AuditLog.action.like("products_bulk%")).count() == 0


# ==================== audit log ====================

def test_bulk_action_writes_audit_log(client, db):
    ids = [make_product(db).id for _ in range(2)]
    client.post("/api/admin/products/bulk-action",
                json={"product_ids": ids, "action": "deactivate"})
    rows = db.query(AuditLog).filter(AuditLog.action == "products_bulk_deactivate").all()
    assert len(rows) == 1
    row = rows[0]
    assert row.actor == "admin:admin@test.local"
    assert str(ids[0]) in (row.detail or "")


def test_single_delete_writes_audit_log(client, db):
    p = make_product(db)
    client.delete(f"/api/admin/products/{p.id}")
    rows = db.query(AuditLog).filter(AuditLog.action == "product_deleted").all()
    assert len(rows) == 1


# ==================== поиск + пагинация ====================

def test_search_by_sku(client, db):
    make_product(db, title="Смартфон А", sku="ALPHA-128")
    make_product(db, title="Ноутбук Б", sku="BETA-512")
    r = client.get("/api/admin/products", params={"q": "beta"})
    assert r.status_code == 200
    data = r.json()
    skus = [p["sku"] for p in data["products"]]
    assert "BETA-512" in skus
    assert "ALPHA-128" not in skus


def test_search_by_title(client, db):
    make_product(db, title="Уникальное Название X", sku="X1")
    make_product(db, title="Другой товар", sku="Y1")
    r = client.get("/api/admin/products", params={"q": "уникальное"})
    assert r.status_code == 200
    titles = [p["title"] for p in r.json()["products"]]
    assert titles == ["Уникальное Название X"]


def test_pagination(client, db):
    for i in range(120):
        make_product(db, title=f"Товар {i:03d}", sku=f"SKU{i:03d}")
    r = client.get("/api/admin/products", params={"page": 1, "page_size": 50})
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 120
    assert data["page_size"] == 50
    assert data["pages"] == 3
    assert len(data["products"]) == 50
    r2 = client.get("/api/admin/products", params={"page": 3, "page_size": 50})
    assert len(r2.json()["products"]) == 20


def test_list_returns_facets(client, db):
    make_product(db, brand="Apple", category="смартфоны")
    make_product(db, brand="Samsung", category="смартфоны")
    r = client.get("/api/admin/products")
    data = r.json()
    assert set(data["categories"]) == {"смартфоны"}
    assert set(data["brands"]) == {"Apple", "Samsung"}


def test_is_limited_patchable_and_exposed_in_card(client, db):
    """«Осталось N шт» на витрине — следствие флага is_limited, а не малого
    склада: флаг ставится из админки и приезжает во фронтовую карточку."""
    p = make_product(db, stock=3, in_stock=True)
    assert p.is_limited is False           # по умолчанию дефицит не показываем
    assert p.to_card()["is_limited"] is False

    r = client.patch(f"/api/admin/products/{p.id}", json={"is_limited": True})
    assert r.status_code == 200
    db.refresh(p)
    assert p.is_limited is True
    assert p.to_card()["is_limited"] is True
    assert p.to_admin()["is_limited"] is True
