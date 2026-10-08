"""Режим администратора Mini App и история цен (07.10.2026).

Повод: цены меняли скрипты в обход всего — истории не было, и «что стояло
вчера» можно было узнать только из полного бэкапа базы.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.security import _create_token, create_access_token
from app.db.session import get_db
from app.main import app
from app.models.price_change import PriceChange
from app.models.staff_login import StaffLogin
from app.models.user import User
from app.services import price_history, staff_auth
from tests.conftest import make_product

ADMIN = 8614709711
STRANGER = 111


@pytest.fixture()
def client(db, monkeypatch):
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_IDS", str(ADMIN))
    monkeypatch.setattr(settings, "BOT_USERNAME", "isellerbot")
    sent: list = []
    monkeypatch.setattr(staff_auth, "notify", lambda chat, text, button=None: sent.append((chat, text, button)) or True)
    app.dependency_overrides[get_db] = lambda: db
    c = TestClient(app)
    c.sent = sent
    yield c
    app.dependency_overrides.clear()


def _user(db, tg: int) -> dict:
    u = User(telegram_id=tg)
    db.add(u)
    db.commit()
    return {"Authorization": f"Bearer {create_access_token(f'user:{u.id}')}"}


def _staff(tg: int = ADMIN) -> dict:
    return {"Authorization": f"Bearer {_create_token(f'staff:{tg}', 'staff', timedelta(hours=1))}"}


# ---------------------------------------------------------------- история ----
def test_any_price_change_is_recorded(db):
    p = make_product(db, price=120000)
    p.price = 132500
    db.commit()
    rows = db.query(PriceChange).all()
    assert [(float(r.old_price), float(r.new_price), r.actor, r.source) for r in rows] == \
        [(120000.0, 132500.0, "system", "unknown")]


def test_attribution_and_no_row_without_change(db):
    p = make_product(db, price=1000)
    price_history.attribute(db, actor="tg:1", source="staff")
    p.price = 1000          # то же значение — не изменение
    p.title = "другое"
    db.commit()
    assert db.query(PriceChange).count() == 0
    p.price = 900
    db.commit()
    row = db.query(PriceChange).one()
    assert (row.actor, row.source) == ("tg:1", "staff")


# ------------------------------------------------------------------- вход ----
def test_payload_parsing():
    assert staff_auth.parse_confirm_payload("/start staffok_abcdefghijkl") == "abcdefghijkl"
    assert staff_auth.parse_confirm_payload("/start catalog") is None
    assert staff_auth.parse_confirm_payload("staffok_abcdefghijkl") is None
    assert staff_auth.parse_confirm_payload("/start staffok_x") is None


def test_eligible_only_for_listed_ids(client, db):
    assert client.get("/api/staff/eligible", headers=_user(db, ADMIN)).json() == {"eligible": True}
    assert client.get("/api/staff/eligible", headers=_user(db, STRANGER)).json() == {"eligible": False}


def test_stranger_cannot_start_login_and_owner_is_alerted(client, db):
    r = client.post("/api/staff/login", headers=_user(db, STRANGER))
    assert r.status_code == 403
    assert client.sent and client.sent[0][0] == ADMIN and "чужого" in client.sent[0][1]
    assert db.query(StaffLogin).count() == 0


def test_full_login_flow_requires_confirmation_from_same_account(client, db):
    headers = _user(db, ADMIN)
    r = client.post("/api/staff/login", headers=headers)
    assert r.status_code == 200
    rid = r.json()["request_id"]
    chat, _text, button = client.sent[-1]
    assert chat == ADMIN and button[1].startswith("https://t.me/isellerbot?start=staffok_")
    nonce = button[1].split("staffok_")[1]

    assert client.get(f"/api/staff/login/{rid}", headers=headers).json() == {"status": "pending"}
    # Чужой аккаунт нажал ссылку — заявка сгорает.
    assert staff_auth.approve(db, nonce, STRANGER) == "foreign"
    db.commit()
    assert client.get(f"/api/staff/login/{rid}", headers=headers).json() == {"status": "expired"}

    rid = client.post("/api/staff/login", headers=headers).json()["request_id"]
    nonce = client.sent[-1][2][1].split("staffok_")[1]
    assert staff_auth.approve(db, nonce, ADMIN) == "ok"
    db.commit()
    body = client.get(f"/api/staff/login/{rid}", headers=headers).json()
    assert body["status"] == "approved" and body["token"]
    # Токен по заявке выдаётся ровно один раз.
    assert client.get(f"/api/staff/login/{rid}", headers=headers).json() == {"status": "expired"}
    # Выданный токен работает на staff API.
    assert client.get("/api/staff/products", headers={"Authorization": f"Bearer {body['token']}"}).status_code == 200


def test_expired_login_cannot_be_approved(client, db):
    headers = _user(db, ADMIN)
    client.post("/api/staff/login", headers=headers)
    nonce = client.sent[-1][2][1].split("staffok_")[1]
    row = db.query(StaffLogin).one()
    row.created_at = datetime.now(timezone.utc) - timedelta(minutes=6)
    db.commit()
    assert staff_auth.approve(db, nonce, ADMIN) == "expired"


def test_user_token_does_not_open_staff_api(client, db):
    assert client.get("/api/staff/products", headers=_user(db, ADMIN)).status_code == 401
    assert client.get("/api/staff/products").status_code == 401


def test_staff_token_dies_when_removed_from_list(client, db, monkeypatch):
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_IDS", "999")
    assert client.get("/api/staff/products", headers=_staff()).status_code == 403


# ------------------------------------------------------------------ цены ----
def test_patch_price_writes_history_with_actor(client, db):
    p = make_product(db, price=120000, sku="MDVH4")
    r = client.patch(f"/api/staff/products/{p.id}", json={"price": 132500}, headers=_staff())
    assert r.status_code == 200 and r.json()["price"] == 132500
    row = db.query(PriceChange).one()
    assert (row.actor, row.source) == (f"tg:{ADMIN}", "staff")


def test_big_change_needs_confirmation(client, db):
    p = make_product(db, price=120000)
    r = client.patch(f"/api/staff/products/{p.id}", json={"price": 12000}, headers=_staff())
    assert r.status_code == 409 and r.json()["detail"]["code"] == "need_confirm"
    assert client.patch(f"/api/staff/products/{p.id}", json={"price": 12000, "confirm": True},
                        headers=_staff()).status_code == 200


def test_price_bounds(client, db):
    p = make_product(db, price=1000)
    assert client.patch(f"/api/staff/products/{p.id}", json={"price": 0, "confirm": True},
                        headers=_staff()).status_code == 422


def test_history_and_revert(client, db):
    p = make_product(db, price=120000)
    client.patch(f"/api/staff/products/{p.id}", json={"price": 132500}, headers=_staff())
    hist = client.get(f"/api/staff/products/{p.id}/history", headers=_staff()).json()["items"]
    assert hist[0]["old_price"] == 120000 and hist[0]["new_price"] == 132500
    r = client.post(f"/api/staff/products/{p.id}/revert/{hist[0]['id']}", headers=_staff())
    assert r.json()["price"] == 120000
    assert db.query(PriceChange).count() == 2


def test_list_search_and_filters(client, db):
    make_product(db, title="MacBook Air 15", sku="MDVH4", price=1)
    make_product(db, title="iPhone 17", sku="IP-17", price=2, in_stock=False)
    items = client.get("/api/staff/products?q=mdvh4", headers=_staff()).json()["items"]
    assert [i["sku"] for i in items] == ["MDVH4"]
    out = client.get("/api/staff/products?filter=out_of_stock", headers=_staff()).json()["items"]
    assert [i["sku"] for i in out] == ["IP-17"]


def test_resume_after_app_was_closed(client, db):
    """Окно свернули, пока жали «Подтвердить» в боте: подтверждение не теряется."""
    headers = _user(db, ADMIN)
    assert client.post("/api/staff/login/resume", headers=headers).json() == {"status": "none"}
    client.post("/api/staff/login", headers=headers)
    nonce = client.sent[-1][2][1].split("staffok_")[1]
    assert staff_auth.approve(db, nonce, ADMIN) == "ok"
    db.commit()
    body = client.post("/api/staff/login/resume", headers=headers).json()
    assert body["status"] == "approved" and body["token"]
    # Выдаётся один раз.
    assert client.post("/api/staff/login/resume", headers=headers).json() == {"status": "none"}


def test_resume_is_not_for_strangers_or_stale(client, db):
    admin = _user(db, ADMIN)
    client.post("/api/staff/login", headers=admin)
    nonce = client.sent[-1][2][1].split("staffok_")[1]
    staff_auth.approve(db, nonce, ADMIN)
    db.commit()
    assert client.post("/api/staff/login/resume", headers=_user(db, STRANGER)).json() == {"status": "none"}
    row = db.query(StaffLogin).one()
    row.approved_at = datetime.now(timezone.utc) - timedelta(minutes=6)
    db.commit()
    assert client.post("/api/staff/login/resume", headers=admin).json() == {"status": "none"}


def test_admin_command_in_bot_opens_admin_for_five_minutes(client, db, monkeypatch):
    """/admin в личке бота = готовое подтверждение; Mini App забирает его по кнопке."""
    from contextlib import contextmanager
    import app.db.session as session_mod

    @contextmanager
    def same_db():
        yield db
    monkeypatch.setattr(session_mod, "SessionLocal", same_db)

    upd = lambda tg, chat_type="private": {"message": {
        "text": "/admin", "from": {"id": tg}, "chat": {"id": tg, "type": chat_type}}}
    assert staff_auth.handle_bot_update(upd(STRANGER)) is None          # чужим — обычный ответ
    assert staff_auth.handle_bot_update(upd(ADMIN, "supergroup")) is None  # не в группах
    assert "5 минут" in staff_auth.handle_bot_update(upd(ADMIN))
    assert staff_auth.last_outcome.pop(ADMIN) == "ok"
    body = client.post("/api/staff/login/resume", headers=_user(db, ADMIN)).json()
    assert body["status"] == "approved" and body["token"]


def _signed_init_data(tg: int, age_seconds: int = 0) -> str:
    """initData, подписанный так же, как это делает Telegram."""
    import hashlib, hmac, json, time
    from urllib.parse import urlencode
    fields = {"auth_date": str(int(time.time()) - age_seconds),
              "user": json.dumps({"id": tg, "first_name": "A"})}
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", settings.TELEGRAM_BOT_TOKEN.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def test_instant_login_one_tap(client, db, monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_BOT_TOKEN", "123:abc")
    body = client.post("/api/staff/login/instant", json={"init_data": _signed_init_data(ADMIN)}).json()
    assert body["status"] == "approved" and body["token"]
    assert any("Вход в режим администратора" in t for _c, t, _b in client.sent)   # админ узнаёт о входе


def test_instant_login_refuses_stale_forged_or_stranger(client, db, monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_BOT_TOKEN", "123:abc")
    none = {"status": "none"}
    assert client.post("/api/staff/login/instant", json={"init_data": _signed_init_data(ADMIN, 300)}).json() == none
    assert client.post("/api/staff/login/instant", json={"init_data": _signed_init_data(STRANGER)}).json() == none
    forged = _signed_init_data(ADMIN).replace("hash=", "hash=0")
    assert client.post("/api/staff/login/instant", json={"init_data": forged}).json() == none
