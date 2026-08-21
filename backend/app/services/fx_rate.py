"""Курс USD (ЦБ РФ): наполнение истории + чтение для чипа/графика главной.

Одна строка в fx_rate_history на календарный день — это и кэш текущего
значения (последняя по дате строка), и источник для графика за N дней.
Отдельного in-memory TTL-кэша нет: таблица читается напрямую, дешёвый запрос.

sync() вызывается из фонового тика бота (app/scripts/bot_polling.py) на
каждом тике (≤30с), но реально бьёт по сети не чаще раза в день — идёт в
БД первым и решает по наличию строки на сегодня. Сетевая ошибка ловится
здесь же и не поднимается наружу (fail-soft, тот же принцип, что у
core/rate_limit.py и _warm_gateway).
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.fx_rate import FxRateHistory

logger = logging.getLogger("techshop.fx_rate")

CBR_DAILY_JSON_URL = "https://www.cbr-xml-daily.ru/daily_json.js"


def sync(db: Session) -> bool:
    """Вставляет строку за сегодня, если её ещё нет. True — вставили."""
    exists = db.execute(
        select(FxRateHistory.id).where(FxRateHistory.date == date.today())
    ).first()
    if exists is not None:
        return False

    try:
        resp = httpx.get(CBR_DAILY_JSON_URL, timeout=10)
        if resp.status_code >= 400:
            logger.warning("ЦБ вернул %d", resp.status_code)
            return False
        value = float(resp.json()["Valute"]["USD"]["Value"])
    except Exception:  # noqa: BLE001 — сеть/парсинг необязательны, отказ не событие
        logger.warning("не удалось получить курс ЦБ РФ", exc_info=True)
        return False

    db.add(FxRateHistory(date=date.today(), value=value))
    db.commit()
    return True


def latest(db: Session) -> dict | None:
    """{"value", "delta"} по последним двум строкам, None — если строк нет."""
    rows = db.execute(
        select(FxRateHistory).order_by(FxRateHistory.date.desc()).limit(2)
    ).scalars().all()
    if not rows:
        return None
    current = float(rows[0].value)
    previous = float(rows[1].value) if len(rows) > 1 else current
    return {"value": current, "delta": current - previous}


def history(db: Session, days: int) -> list[dict]:
    """Последние `days` строк по возрастанию даты: [{"date", "value"}, ...]."""
    cutoff = date.today() - timedelta(days=days)
    rows = db.execute(
        select(FxRateHistory)
        .where(FxRateHistory.date >= cutoff)
        .order_by(FxRateHistory.date.asc())
    ).scalars().all()
    return [{"date": r.date.isoformat(), "value": float(r.value)} for r in rows]
