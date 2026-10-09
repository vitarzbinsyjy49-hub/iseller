"""Ежедневное обновление прайс-постов канала из базы (10:30 МСК).

Повод (07.10.2026): посты-прайсы не обновлялись с 24.09 — две недели в канале
висели 214 старых цен, и покупатель приходил за MacBook по цене, которой уже нет.
Пайплайн текста (services/price_channel) всегда строился из базы, но его никто
не запускал после смены цен.

Правила:
- только action == "update" — правка уже опубликованных сообщений. Новый пост
  (create: секция разрослась на новую страницу) — это новое сообщение в канале,
  его владелец решает сам; задание о нём только сообщает;
- один прогон в день: отметка — строка audit_logs за сегодняшнюю дату МСК, так
  рестарт бота на деплое не повторяет прогон и сводку;
- включается флагом PRICE_CHANNEL_DAILY_SYNC — правка публичного канала не
  должна начаться сама собой от деплоя.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.audit import AuditLog

logger = logging.getLogger("techshop.daily_price_sync")

MSK = timezone(timedelta(hours=3))
ACTION = "price_channel_daily"


def run_at() -> time:
    raw = (settings.PRICE_CHANNEL_SYNC_AT or "10:30").strip()
    try:
        hh, mm = raw.split(":")
        return time(int(hh), int(mm))
    except ValueError:
        return time(10, 30)


def is_due(now_msk: datetime, already_ran_today: bool) -> bool:
    return not already_ran_today and now_msk.time() >= run_at()


def _ran_today(db: Session, today: date) -> bool:
    start = datetime.combine(today, time(0, 0), MSK)
    return db.execute(select(AuditLog.id).where(
        AuditLog.action == ACTION, AuditLog.created_at >= start)).first() is not None


def summary_text(updated: list[str], pending_create: list[str], failed: list[tuple[str, str]],
                 price_lines: int) -> str:
    lines = ["📋 <b>Прайс в канале обновлён</b>",
             f"Постов обновлено: {len(updated)}, строк с новой ценой: {price_lines}."]
    if pending_create:
        lines.append(f"Нужны новые посты (секция не помещается): {', '.join(pending_create)} — "
                     "создаются только вручную в админке «Прайс канала».")
    if failed:
        lines.append("Не удалось: " + "; ".join(f"{s} ({e})" for s, e in failed))
    return "\n".join(lines)


def run(db: Session, *, mark: bool = True) -> dict:
    """Один прогон. Возвращает итог для лога. mark=False — внеплановое обновление
    (после выгрузки BSA): плановый прогон в 10:30 им не отменяется."""
    from app.services import price_channel, staff_auth

    plans = price_channel.build_plan(db)
    to_update = [p.slug for p in plans if p.action == "update" and not p.over_limit]
    pending_create = [p.slug for p in plans if p.action == "create"]
    price_lines = sum(len(p.price_changes) for p in plans if p.slug in set(to_update))
    result = price_channel.apply_plan(db, slugs=to_update) if to_update else None
    updated = result.updated if result else []
    failed = (result.failed if result else []) + [(p.slug, "превышен лимит") for p in plans if p.over_limit]
    db.add(AuditLog(actor="system", action=ACTION if mark else ACTION + "_extra",
                    detail=f"updated={len(updated)};price_lines={price_lines};"
                           f"create_pending={len(pending_create)};failed={len(failed)}"))
    db.commit()
    text = summary_text(updated, pending_create, failed, price_lines)
    for tg_id in sorted(staff_auth.allowed_ids()):
        staff_auth.notify(tg_id, text)
    return {"updated": len(updated), "price_lines": price_lines,
            "create_pending": len(pending_create), "failed": len(failed)}


def maybe_run(db: Session, now_utc: datetime | None = None) -> dict | None:
    """Для цикла бота: прогон, если включено, время пришло и сегодня ещё не было."""
    if not settings.PRICE_CHANNEL_DAILY_SYNC:
        return None
    now_msk = (now_utc or datetime.now(timezone.utc)).astimezone(MSK)
    if not is_due(now_msk, _ran_today(db, now_msk.date())):
        return None
    return run(db)
