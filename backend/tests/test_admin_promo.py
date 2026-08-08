"""Админ-API промокодов: создание, правка, выключение, расход."""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.audit import AuditLog
from app.models.promo import PromoCode, PromoRedemption
from app.models.user import User


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=920, first_name="Гриша", username="grisha")
    db.add(u)
    db.commit()
    db.refresh(u)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    try:
        yield TestClient(app), db, u
    finally:
        app.dependency_overrides.clear()


def _create(client, **kw):
    body = {"code": "start20", "discount_amount": 5000, "max_redemptions": 20}
    body.update(kw)
    return client.post("/api/admin/promo-codes", json=body)


def test_create_normalizes_code(ctx):
    client, _db, _u = ctx
    r = _create(client)
    assert r.status_code == 201
    assert r.json()["code"] == "START20"
    assert r.json()["used"] == 0
    assert r.json()["left"] == 20


def test_duplicate_code_rejected(ctx):
    client, _db, _u = ctx
    assert _create(client).status_code == 201
    r = _create(client)
    assert r.status_code == 409


def test_create_rejects_bad_code(ctx):
    client, _db, _u = ctx
    assert _create(client, code="скидка!").status_code == 422


def test_create_rejects_non_positive_discount(ctx):
    client, _db, _u = ctx
    assert _create(client, discount_amount=0).status_code == 422


def test_list_shows_usage(ctx):
    client, db, u = ctx
    promo_id = _create(client).json()["id"]
    db.add(PromoRedemption(promo_id=promo_id, user_id=u.id, lead_id=None,
                           discount_amount=5000, order_total=100000))
    db.commit()

    rows = client.get("/api/admin/promo-codes").json()["items"]
    assert len(rows) == 1
    assert rows[0]["used"] == 1
    assert rows[0]["left"] == 19


def test_list_counts_are_per_code(ctx):
    """Расход одного кода не должен подмешиваться в другой."""
    client, db, u = ctx
    a = _create(client, code="AAA").json()["id"]
    _create(client, code="BBB")
    db.add(PromoRedemption(promo_id=a, user_id=u.id, lead_id=None,
                           discount_amount=1, order_total=10))
    db.commit()

    by_code = {r["code"]: r for r in client.get("/api/admin/promo-codes").json()["items"]}
    assert by_code["AAA"]["used"] == 1
    assert by_code["BBB"]["used"] == 0


def test_deactivate(ctx):
    client, db, _u = ctx
    promo_id = _create(client).json()["id"]
    r = client.patch(f"/api/admin/promo-codes/{promo_id}", json={"is_active": False})
    assert r.status_code == 200
    assert r.json()["is_active"] is False
    assert db.get(PromoCode, promo_id).is_active is False


def test_patch_writes_audit(ctx):
    """Выключение акции — опасное действие, оно обязано быть в журнале."""
    client, db, _u = ctx
    promo_id = _create(client).json()["id"]
    client.patch(f"/api/admin/promo-codes/{promo_id}", json={"is_active": False})
    actions = [a.action for a in db.query(AuditLog).all()]
    assert "promo_code_updated" in actions
    assert "promo_code_created" in actions


def test_redemptions_list(ctx):
    client, db, u = ctx
    promo_id = _create(client).json()["id"]
    db.add(PromoRedemption(promo_id=promo_id, user_id=u.id, lead_id=None,
                           discount_amount=5000, order_total=100000))
    db.commit()

    r = client.get(f"/api/admin/promo-codes/{promo_id}/redemptions")
    assert r.status_code == 200
    rows = r.json()["items"]
    assert len(rows) == 1
    assert rows[0]["discount_amount"] == 5000
    # Менеджеру нужен человек, а не user_id: иначе строку не с кем связать.
    assert rows[0]["username"] == "grisha"


def test_delete_code_keeps_history(ctx):
    """Удаление кода не должно стирать факт, что купоны были выданы."""
    client, db, u = ctx
    promo_id = _create(client).json()["id"]
    db.add(PromoRedemption(promo_id=promo_id, user_id=u.id, lead_id=None,
                           discount_amount=5000, order_total=100000))
    db.commit()
    r = client.delete(f"/api/admin/promo-codes/{promo_id}")
    # Код с расходом не удаляем — его выключают. История дороже чистоты списка.
    assert r.status_code == 409
    assert db.query(PromoRedemption).count() == 1


def test_delete_unused_code_allowed(ctx):
    client, db, _u = ctx
    promo_id = _create(client).json()["id"]
    assert client.delete(f"/api/admin/promo-codes/{promo_id}").status_code == 200
    assert db.get(PromoCode, promo_id) is None


def test_requires_admin(ctx):
    """Ручки промокодов не должны открываться обычным пользователем."""
    client, _db, _u = ctx
    app.dependency_overrides.pop(get_current_admin)
    assert client.get("/api/admin/promo-codes").status_code in (401, 403)
