"""Сценарные заявки (v5.4.0): lead_type + metadata.

Покрывает обратную совместимость (старый POST без новых полей), сохранение
trade_in/b2b/wholesale, нормализацию неизвестного типа, валидацию metadata,
отсутствие PII в аналитике, фильтр админки по типу и to_dict.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.analytics_event import AnalyticsEvent
from app.models.lead import Lead
from app.models.user import User
from app.schemas.ai import (
    META_MAX_BYTES,
    normalize_lead_type,
    sanitize_lead_metadata,
)


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=501, first_name="Гриша", username="grisha")
    db.add(u)
    db.commit()
    db.refresh(u)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, u
    finally:
        app.dependency_overrides.clear()


# ---------------- обратная совместимость ----------------

def test_old_client_without_new_fields(ctx):
    """Старый клиент шлёт только базовые поля — lead_type=general, metadata={}."""
    client, db, _u = ctx
    r = client.post("/api/leads", json={"phone": "+79990000000", "source": "product"})
    assert r.status_code == 201
    body = r.json()
    assert body["lead_type"] == "general"
    assert body["metadata"] == {}
    assert body["source"] == "product"


def test_trade_in_b2b_wholesale_saved(ctx):
    client, db, _u = ctx
    payload = {
        "source": "home",
        "lead_type": "trade_in",
        "metadata": {
            "origin": "home_quick_scenario",
            "device_type": "iphone",
            "model": "iPhone 15 Pro",
            "condition": "normal",
            "intent": "exchange",
        },
    }
    r = client.post("/api/leads", json=payload)
    assert r.status_code == 201
    body = r.json()
    assert body["lead_type"] == "trade_in"
    assert body["source"] == "home"
    assert body["metadata"]["model"] == "iPhone 15 Pro"
    assert body["metadata"]["origin"] == "home_quick_scenario"

    for t in ("b2b", "wholesale"):
        rr = client.post("/api/leads", json={"source": "home", "lead_type": t, "metadata": {"city": "Москва"}})
        assert rr.status_code == 201 and rr.json()["lead_type"] == t


def test_invalid_lead_type_normalized(ctx):
    """Неизвестный тип нормализуется в general (безопасно, не 500)."""
    client, *_ = ctx
    r = client.post("/api/leads", json={"source": "home", "lead_type": "hacker_type"})
    assert r.status_code == 201
    assert r.json()["lead_type"] == "general"


# ---------------- валидация metadata ----------------

def test_metadata_must_be_object(ctx):
    client, *_ = ctx
    r = client.post("/api/leads", json={"source": "home", "lead_type": "b2b", "metadata": "not-an-object"})
    assert r.status_code == 422


def test_metadata_key_and_string_limits():
    """Слишком много ключей — обрезается; длинные строки — тримятся; вложенные
    объекты и пустые значения отбрасываются."""
    raw = {f"k{i}": f"v{i}" for i in range(100)}
    raw["long"] = "x" * 5000
    raw["nested"] = {"a": 1}       # вложенный объект отбрасывается
    raw["empty"] = ""              # пустое отбрасывается
    raw["num"] = 42
    raw["flag"] = True
    cleaned = sanitize_lead_metadata(raw)
    assert len(cleaned) <= 24
    assert "nested" not in cleaned
    assert "empty" not in cleaned
    if "long" in cleaned:
        assert len(cleaned["long"]) <= 500


def test_metadata_oversized_rejected():
    raw = {f"key{i}": "y" * 500 for i in range(24)}
    with pytest.raises(ValueError):
        sanitize_lead_metadata(raw)
    # и сериализованный лимит действительно жёсткий
    assert META_MAX_BYTES < 24 * 500


def test_normalize_lead_type_unit():
    assert normalize_lead_type(None) == "general"
    assert normalize_lead_type("") == "general"
    assert normalize_lead_type("TRADE_IN") == "trade_in"
    assert normalize_lead_type("nope") == "general"


# ---------------- аналитика без PII ----------------

def test_analytics_lead_created_has_no_pii(ctx):
    client, db, _u = ctx
    r = client.post("/api/leads", json={
        "name": "Секрет Имя", "phone": "+79990001122", "source": "home",
        "lead_type": "wholesale", "message": "секретный комментарий",
        "metadata": {"city": "Казань", "budget": "3000000"},
    })
    assert r.status_code == 201
    ev = db.query(AnalyticsEvent).filter(AnalyticsEvent.event == "lead_created").one()
    payload = ev.payload
    assert set(payload.keys()) == {"lead_id", "source", "lead_type", "product_id"}
    assert payload["lead_type"] == "wholesale"
    blob = str(payload)
    for pii in ("Секрет", "79990001122", "секретный", "Казань", "3000000"):
        assert pii not in blob


# ---------------- клиент не задаёт status/assigned_to ----------------

def test_client_cannot_set_status(ctx):
    """LeadIn не содержит status/assigned_to/telegram_id — сервер их игнорирует."""
    client, db, u = ctx
    r = client.post("/api/leads", json={
        "source": "home", "lead_type": "b2b", "status": "completed",
        "assigned_to": "self", "telegram_id": 999999,
    })
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "new"
    assert body["assigned_to"] is None
    assert body["telegram_id"] == u.telegram_id   # из auth, не из тела


# ---------------- admin filter + to_dict ----------------

def test_admin_filter_by_lead_type(ctx):
    client, db, _u = ctx
    client.post("/api/leads", json={"source": "home", "lead_type": "trade_in"})
    client.post("/api/leads", json={"source": "home", "lead_type": "b2b"})
    client.post("/api/leads", json={"source": "product"})  # general

    all_leads = client.get("/api/admin/leads").json()["leads"]
    assert len(all_leads) == 3
    assert all("lead_type" in l and "metadata" in l for l in all_leads)

    trade = client.get("/api/admin/leads?type_filter=trade_in").json()["leads"]
    assert len(trade) == 1 and trade[0]["lead_type"] == "trade_in"

    general = client.get("/api/admin/leads?type_filter=general").json()["leads"]
    assert len(general) == 1 and general[0]["lead_type"] == "general"


def test_to_dict_includes_new_fields(db):
    lead = Lead(source="home", lead_type="b2b", meta={"city": "Москва"}, status="new")
    db.add(lead)
    db.commit()
    db.refresh(lead)
    d = lead.to_dict()
    assert d["lead_type"] == "b2b"
    assert d["metadata"] == {"city": "Москва"}
