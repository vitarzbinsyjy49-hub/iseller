"""Приём прайсов от «читателя» (tools/tg_reader на финском сервере).

С основного VPS Telegram как пользователь недоступен (MTProto режется), поэтому
посты BSA и apostl price читает отдельный процесс из Финляндии и присылает сюда
ТЕКСТЫ. Вся логика сверки остаётся прежней: bsa идёт в daily_bsa_check.run
(цена = BSA − 500, порог 25%, отчёт админам), apostl копится справкой и цен не
меняет — как ставить цены по нему, решает владелец.

Сторож: читатель обязан прислать данные до 10:25 МСК, иначе админам уходит
сообщение, а публичный виджет (daily_bsa_check) продолжает покрывать часть
постов.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.audit import AuditLog

logger = logging.getLogger("techshop.price_reader")

MSK = timezone(timedelta(hours=3))
SOURCES = ("bsa", "apostl")
APOSTL_ACTION = "price_reader_apostl"
MISSING_ACTION = "price_reader_missing"
DEADLINE = time(10, 25)

MAX_POSTS = 300
MAX_TEXT = 120_000


class BadPayload(ValueError):
    """Пакет читателя не принят — текст ошибки безопасно отдавать в ответ."""


def _clean(payload: dict) -> tuple[str, dict[int, str], list[int]]:
    source = payload.get("source")
    if source not in SOURCES:
        raise BadPayload("source должен быть bsa или apostl")
    raw = payload.get("texts")
    if not isinstance(raw, dict) or not raw:
        raise BadPayload("texts пуст: читатель ничего не прочитал")
    if len(raw) > MAX_POSTS:
        raise BadPayload(f"слишком много постов ({len(raw)} > {MAX_POSTS})")
    texts: dict[int, str] = {}
    for key, text in raw.items():
        if not re.fullmatch(r"\d{1,12}", str(key)) or not isinstance(text, str):
            raise BadPayload("ключ поста — число, текст — строка")
        if len(text) > MAX_TEXT:
            raise BadPayload(f"пост {key} длиннее {MAX_TEXT} символов")
        if text.strip():
            texts[int(key)] = text
    if not texts:
        raise BadPayload("во всех постах пустой текст")
    failed = [int(x) for x in payload.get("failed") or [] if str(x).isdigit()]
    return source, texts, failed


def accept(db: Session, payload: dict) -> dict:
    """Принять пакет читателя. BadPayload — пакет отклонён, в базу ничего не попало."""
    from app.services import daily_bsa_check, daily_price_sync, price_sync
    from app.services.source_lines import parse_text

    source, texts, failed = _clean(payload)
    if source == "apostl":
        lines = sum(price_sync.ingest(db, parse_text(t), post_id=i, source="apostl")
                    for i, t in texts.items())
        db.add(AuditLog(actor="system", action=APOSTL_ACTION,
                        detail=f"posts={len(texts)};lines={lines};failed={len(failed)}"))
        db.commit()
        return {"source": source, "posts": len(texts), "lines": lines, "applied": 0}
    stats = daily_bsa_check.run(db, texts=texts, failed=failed, origin="reader")
    if stats["applied"]:
        daily_price_sync.run(db, mark=False)
    return {"source": source, **{k: stats[k] for k in ("posts", "lines", "failed", "applied", "held")}}


# ------------------------------------------------------------------ сторож ----
def reader_ran_today(db: Session, today: date) -> bool:
    """Читатель прислал BSA без пропусков (failed=0) сегодня."""
    start = datetime.combine(today, time(0, 0), MSK).astimezone(timezone.utc)
    rows = db.execute(select(AuditLog.detail).where(
        AuditLog.action == "bsa_daily_check", AuditLog.created_at >= start)).scalars()
    return any(d and d.startswith("origin=reader;") and ";failed=0;" in d + ";" for d in rows)


def _missing_alerted(db: Session, today: date) -> bool:
    start = datetime.combine(today, time(0, 0), MSK).astimezone(timezone.utc)
    return db.execute(select(AuditLog.id).where(
        AuditLog.action == MISSING_ACTION, AuditLog.created_at >= start)).first() is not None


def missing_text() -> str:
    return ("⚠️ <b>Читатель BSA не прислал цены</b>\n"
            "Сегодня до 10:25 данных из Telegram нет — iPhone, Watch S11/S12 и стайлеры Dyson "
            "остались со вчерашними ценами, остальное сверено по публичным постам.\n"
            "Проверьте сервер <code>fi</code>: <code>systemctl status iseller-reader.timer</code>, "
            "или пришлите боту result.json.")


def maybe_alert_missing(db: Session, now_utc: datetime | None = None) -> bool:
    """Раз в день после 10:25 МСК: читатель настроен, но данных нет — сказать админам."""
    if not settings.PRICE_READER_TOKEN:
        return False
    now_msk = (now_utc or datetime.now(timezone.utc)).astimezone(MSK)
    if now_msk.time() < DEADLINE or reader_ran_today(db, now_msk.date()) \
            or _missing_alerted(db, now_msk.date()):
        return False
    from app.services import staff_auth
    db.add(AuditLog(actor="system", action=MISSING_ACTION, detail="reader silent"))
    db.commit()
    for tg_id in sorted(staff_auth.allowed_ids()):
        staff_auth.notify(tg_id, missing_text(), web_app=staff_auth.open_admin_button())
    return True
