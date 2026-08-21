"""Сервис курса USD: наполнение из ЦБ РФ + чтение для чипа/графика.

Правило нуль: без данных — None/[], никогда не 0 и не выдуманное значение
(см. docs/superpowers/specs/2026-08-20-usd-rate-widget-design.md).
"""
from datetime import date, timedelta

import httpx
import pytest

from app.models.fx_rate import FxRateHistory
from app.services import fx_rate


def _cbr_response(value: float, previous: float = 0.0) -> dict:
    return {"Valute": {"USD": {"Value": value, "Previous": previous}}}


def test_sync_inserts_row_when_missing(db, monkeypatch):
    monkeypatch.setattr(
        httpx, "get",
        lambda *a, **kw: httpx.Response(200, json=_cbr_response(91.23)),
    )
    inserted = fx_rate.sync(db)
    assert inserted is True
    row = db.query(FxRateHistory).one()
    assert row.date == date.today()
    assert float(row.value) == pytest.approx(91.23)


def test_sync_is_idempotent_for_same_day(db, monkeypatch):
    """Второй sync в тот же день не должен звать сеть и не должен дублировать строку."""
    calls = {"n": 0}

    def fake_get(*a, **kw):
        calls["n"] += 1
        return httpx.Response(200, json=_cbr_response(91.23))

    monkeypatch.setattr(httpx, "get", fake_get)
    fx_rate.sync(db)
    inserted_again = fx_rate.sync(db)

    assert inserted_again is False
    assert calls["n"] == 1, "второй sync не должен трогать сеть, если строка на сегодня уже есть"
    assert db.query(FxRateHistory).count() == 1


def test_sync_network_failure_does_not_raise(db, monkeypatch):
    def explode(*a, **kw):
        raise httpx.ConnectError("сеть недоступна")

    monkeypatch.setattr(httpx, "get", explode)
    inserted = fx_rate.sync(db)
    assert inserted is False
    assert db.query(FxRateHistory).count() == 0


def test_latest_returns_none_without_data(db):
    assert fx_rate.latest(db) is None


def test_latest_delta_is_zero_for_single_row(db):
    db.add(FxRateHistory(date=date.today(), value=91.23))
    db.commit()
    result = fx_rate.latest(db)
    assert result == {"value": pytest.approx(91.23), "delta": 0}


def test_latest_delta_against_previous_row(db):
    db.add(FxRateHistory(date=date.today() - timedelta(days=1), value=90.90))
    db.add(FxRateHistory(date=date.today(), value=91.23))
    db.commit()
    result = fx_rate.latest(db)
    assert result["value"] == pytest.approx(91.23)
    assert result["delta"] == pytest.approx(0.33, abs=1e-6)


def test_history_orders_ascending_and_respects_limit(db):
    base = date.today() - timedelta(days=5)
    for i in range(5):
        db.add(FxRateHistory(date=base + timedelta(days=i), value=90 + i))
    db.commit()

    rows = fx_rate.history(db, days=3)
    assert [r["date"] for r in rows] == [
        (base + timedelta(days=2)).isoformat(),
        (base + timedelta(days=3)).isoformat(),
        (base + timedelta(days=4)).isoformat(),
    ]
    assert rows[0]["value"] == pytest.approx(92)


def test_history_returns_fewer_rows_than_days_when_data_is_short(db):
    db.add(FxRateHistory(date=date.today(), value=91.23))
    db.commit()
    rows = fx_rate.history(db, days=30)
    assert len(rows) == 1
