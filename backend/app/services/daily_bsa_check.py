"""Ежедневная сверка с BSA в 10:20 МСК — до обновления прайс-постов в 10:30.

Правило владельца: цена = BSA − 500, ставится автоматически. Читает публичные
посты BSA (services/bsa_fetch), обновляет справочные цены, ставит наши цены
(изменение больше BSA_AUTO_MAX_CHANGE — только с подтверждением) и присылает
админам отчёт «что изменилось». Прайс в группе обновляет daily_price_sync в 10:30.
Один прогон в день (отметка в audit_logs), включается флагом
PRICE_CHANNEL_DAILY_SYNC.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.audit import AuditLog

logger = logging.getLogger("techshop.daily_bsa_check")

MSK = timezone(timedelta(hours=3))
ACTION = "bsa_daily_check"
RUN_AT = time(10, 20)


def _ran_today(db: Session, today: date) -> bool:
    start = datetime.combine(today, time(0, 0), MSK)
    return db.execute(select(AuditLog.id).where(AuditLog.action == ACTION, AuditLog.created_at >= start)).first() is not None


def run(db: Session, *, texts: dict[int, str] | None = None, failed: list[int] | None = None,
        notify: bool = True, origin: str = "daily") -> dict:
    from app.services import bsa_fetch, price_sync, staff_auth
    if texts is None:
        texts, failed = bsa_fetch.fetch_public_posts()
    lines = 0
    for post_id, text in texts.items():
        lines += price_sync.ingest_text(db, text, post_id=post_id)
    diffs, stats = price_sync.discrepancies(db)
    applied, held = ([], diffs)
    if settings.BSA_AUTO_APPLY:
        applied, held = price_sync.auto_apply(db, diffs, settings.BSA_AUTO_MAX_CHANGE)
    stats.update(posts=len(texts), lines=lines, failed=len(failed or []),
                 applied=len(applied), held=len(held))
    db.add(AuditLog(actor="system", action=ACTION,
                    detail=f"origin={origin};" + ";".join(f"{k}={v}" for k, v in stats.items())))
    db.commit()
    if notify:
        text = price_sync.report_text(stats, applied, held, len(texts), failed or [])
        for tg_id in sorted(staff_auth.allowed_ids()):
            staff_auth.notify(tg_id, text, web_app=staff_auth.open_admin_button())
    return stats


def maybe_run(db: Session, now_utc: datetime | None = None) -> dict | None:
    if not settings.PRICE_CHANNEL_DAILY_SYNC:
        return None
    now_msk = (now_utc or datetime.now(timezone.utc)).astimezone(MSK)
    if now_msk.time() < RUN_AT or _ran_today(db, now_msk.date()):
        return None
    return run(db)


MAX_EXPORT_BYTES = 20 * 1024 * 1024    # предел getFile в Bot API


def handle_export_document(update: dict) -> str | None:
    """Админ прислал боту result.json (экспорт канала BSA) — сверить по нему.

    Нужен для rich-постов, которые публичный виджет не отдаёт (iPhone, Watch
    S11/S12, стайлеры Dyson). None — апдейт не про это."""
    from app.services import staff_auth
    message = update.get("message") or {}
    doc = message.get("document") or {}
    sender = (message.get("from") or {}).get("id")
    if not doc or not staff_auth.is_admin(sender):
        return None
    name = (doc.get("file_name") or "").lower()
    if not name.endswith(".json"):
        return None
    if int(doc.get("file_size") or 0) > MAX_EXPORT_BYTES:
        return "Файл больше 20 МБ — Telegram не даёт боту его скачать. Пришлите выгрузку только канала BSA."
    import httpx
    from app.db.session import SessionLocal
    from app.services import bsa_fetch
    from app.services.telegram_bot import TELEGRAM_API, telegram_http_kwargs
    token = settings.TELEGRAM_BOT_TOKEN
    try:
        with httpx.Client(timeout=60, **telegram_http_kwargs()) as client:
            info = client.get(f"{TELEGRAM_API}/bot{token}/getFile", params={"file_id": doc["file_id"]}).json()
            path = (info.get("result") or {}).get("file_path")
            if not path:
                return "Не удалось получить файл от Telegram — пришлите ещё раз."
            raw = client.get(f"{TELEGRAM_API}/file/bot{token}/{path}").content
        channel = bsa_fetch.export_channel(raw)
        texts = bsa_fetch.parse_export(raw)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        logger.warning("выгрузка BSA не прочитана: %s", type(exc).__name__)
        return "Не получилось прочитать файл. Это точно result.json из «Экспорта истории чата» (формат JSON)?"
    source = bsa_fetch.export_source(channel)
    if source is None:
        return (f"Это выгрузка канала «{channel or 'без названия'}». Я принимаю только BSA Store "
                "и apostl price — цены ничьи не менял.")
    if source == "apostl":
        # Цены apostl копим отдельно (source=apostl) и НИКОГДА не принимаем за
        # BSA: иначе «−500» уехало бы от чужой цены. Как ставить цены по apostl —
        # решение владельца; пока только справка для «Цен».
        from app.services import price_sync
        from app.services.source_lines import parse_text
        with SessionLocal() as db:
            n = sum(price_sync.ingest(db, parse_text(t), post_id=i, source="apostl") for i, t in texts.items())
            db.commit()
        return f"✅ Выгрузка apostl price сохранена: строк с ценой {n}. Цены в магазине по ней пока не меняю."
    from app.services import daily_price_sync
    with SessionLocal() as db:
        stats = run(db, texts=texts, failed=[], origin="export")
        if stats["applied"]:
            daily_price_sync.run(db, mark=False)
    return (f"✅ Выгрузка принята: сообщений {stats['posts']}, строк с ценой {stats['lines']}, "
            f"цен изменено {stats['applied']}. Отчёт — сообщением выше. "
            "Прайс в группе обновлю сразу.")
