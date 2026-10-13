"""Приём прайсов от читателя с финского сервера и сторож (13.10.2026).

Читатель — отдельный процесс (tools/tg_reader): с основного VPS Telegram как
пользователь недоступен. Здесь проверяем границу: токен, формат пакета,
что BSA идёт в сверку «BSA − 500», а apostl только копится, и что молчание
читателя замечает сторож.
"""
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.models.audit import AuditLog
from app.models.price_ref import PriceRef
from app.db.session import get_db
from app.main import app
from app.services import daily_bsa_check, daily_price_sync, price_reader, price_sync, staff_auth
from tests.conftest import make_product
from tests.test_staff_prices import ADMIN

TOKEN = "t" * 40
POST = "17 Pro 256 Silver-102.700🇭🇰🇰🇷(1sim+e sim)\n"


@pytest.fixture()
def sent(monkeypatch):
    out: list = []
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_IDS", str(ADMIN))
    monkeypatch.setattr(staff_auth, "notify", lambda chat, text, **kw: out.append((chat, text)) or True)
    return out


@pytest.fixture(autouse=True)
def _reader(monkeypatch):
    monkeypatch.setattr(settings, "PRICE_READER_TOKEN", TOKEN)
    monkeypatch.setattr(daily_price_sync, "run", lambda db, mark=True: {})


@pytest.fixture()
def client(db, sent):
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _post(client, payload, token=TOKEN):
    return client.post("/api/price-ingest", json=payload, headers={"X-Reader-Token": token})


def test_disabled_without_token(client, monkeypatch):
    monkeypatch.setattr(settings, "PRICE_READER_TOKEN", "")
    assert _post(client, {"source": "bsa", "texts": {"1": POST}}).status_code == 503
    assert client.get("/api/price-ingest/ping").status_code == 503


@pytest.mark.parametrize("token", ["", "wrong", TOKEN[:-1]])
def test_wrong_token_rejected(client, token):
    assert _post(client, {"source": "bsa", "texts": {"1": POST}}, token).status_code == 401
    assert client.get("/api/price-ingest/ping", headers={"X-Reader-Token": token}).status_code == 401


def test_ping(client):
    assert client.get("/api/price-ingest/ping", headers={"X-Reader-Token": TOKEN}).json() == {"ok": True}


@pytest.mark.parametrize("payload", [
    {"source": "telegram", "texts": {"1": POST}},          # чужой источник
    {"source": "bsa", "texts": {}},                         # читатель ничего не прочитал
    {"source": "bsa", "texts": {"abc": POST}},              # ключ — не число
    {"source": "bsa", "texts": {"1": "   "}},               # пустой текст
    {"source": "bsa", "texts": {"1": "x" * (price_reader.MAX_TEXT + 1)}},
    {"source": "bsa", "texts": {str(i): POST for i in range(price_reader.MAX_POSTS + 1)}},
])
def test_bad_payload_is_rejected_and_writes_nothing(client, db, payload):
    r = _post(client, payload)
    assert r.status_code == 422
    assert db.query(PriceRef).count() == 0


def test_bsa_goes_through_the_minus_500_rule(client, db):
    p = make_product(db, title="iPhone 17 Pro 256 ГБ Silver", sku="IP-17PRO-256-SILVER-HKKR-SIM", price=100000, source="bsa")
    price_sync.seed_links(db)
    r = _post(client, {"source": "bsa", "texts": {"12966": POST}})
    assert r.status_code == 200 and r.json()["source"] == "bsa"
    db.refresh(p)
    assert float(p.price) == 102200            # 102 700 − 500
    row = db.query(AuditLog).filter(AuditLog.action == "bsa_daily_check").one()
    assert row.detail.startswith("origin=reader;")


def test_apostl_is_reference_only_and_never_touches_prices(client, db):
    p = make_product(db, title="iPhone 17 Pro 256 ГБ Silver", sku="IP-17PRO-256-SILVER-HKKR-SIM", price=100000, source="bsa")
    price_sync.seed_links(db)
    r = _post(client, {"source": "apostl", "texts": {"7": POST}})
    assert r.status_code == 200 and r.json()["applied"] == 0 and r.json()["lines"] == 1
    db.refresh(p)
    assert float(p.price) == 100000
    assert {x.source for x in db.query(PriceRef)} == {"apostl"}


# ------------------------------------------------------------------ сторож ----
NOW_LATE = datetime(2026, 10, 13, 7, 30, tzinfo=timezone.utc)     # 10:30 МСК
NOW_EARLY = datetime(2026, 10, 13, 7, 10, tzinfo=timezone.utc)    # 10:10 МСК


def test_watchdog_silent_before_deadline_and_when_disabled(db, sent, monkeypatch):
    assert price_reader.maybe_alert_missing(db, NOW_EARLY) is False
    monkeypatch.setattr(settings, "PRICE_READER_TOKEN", "")
    assert price_reader.maybe_alert_missing(db, NOW_LATE) is False
    assert sent == []


def test_watchdog_alerts_once_when_reader_is_silent(db, sent):
    assert price_reader.maybe_alert_missing(db, NOW_LATE) is True
    assert price_reader.maybe_alert_missing(db, NOW_LATE) is False      # раз в день
    assert len(sent) == 1 and "Читатель BSA не прислал" in sent[0][1]


def test_watchdog_quiet_when_reader_delivered(client, db, sent):
    make_product(db, title="iPhone 17 Pro 256 ГБ Silver", sku="IP-17PRO-256-SILVER-HKKR-SIM", price=100000, source="bsa")
    price_sync.seed_links(db)
    assert _post(client, {"source": "bsa", "texts": {"1": POST}}).status_code == 200
    sent.clear()
    now = datetime.now(timezone.utc).replace(hour=20, minute=0)       # заведомо после 10:25 МСК
    assert price_reader.maybe_alert_missing(db, now) is False and sent == []


def test_partial_reader_run_does_not_block_the_public_widget(client, db):
    """failed>0 — пропуски должен добрать виджет в 10:20, значит «сегодня» ещё не было."""
    _post(client, {"source": "bsa", "texts": {"1": POST}, "failed": [12968]})
    today = datetime.now(daily_bsa_check.MSK).date()
    assert daily_bsa_check._ran_today(db, today) is False
    assert price_reader.reader_ran_today(db, today) is False


def test_full_reader_run_counts_as_todays_check(client, db):
    _post(client, {"source": "bsa", "texts": {"1": POST}})
    today = datetime.now(daily_bsa_check.MSK).date()
    assert daily_bsa_check._ran_today(db, today) is True
    assert price_reader.reader_ran_today(db, today) is True


def test_config_lists_public_and_rich_posts(client):
    from app.services import bsa_fetch
    r = client.get("/api/price-ingest/config", headers={"X-Reader-Token": TOKEN}).json()
    assert {12966, 12968, 12970, 12459} <= set(r["bsa_posts"])
    assert set(bsa_fetch.PUBLIC_POSTS) | set(bsa_fetch.RICH_POSTS) == set(r["bsa_posts"])
    assert client.get("/api/price-ingest/config").status_code == 401
