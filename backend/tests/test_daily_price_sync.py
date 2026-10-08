"""Ежедневное обновление прайс-постов канала (07.10.2026)."""
from datetime import datetime, timezone

from app.core.config import settings
from app.models.audit import AuditLog
from app.services import daily_price_sync as dps
from app.services.price_channel import ApplyResult, PostPlan


def _plan(slug, action, changes=0):
    return PostPlan(slug=slug, section_slug=slug, title=slug, text="t", item_count=1, keyboard=[],
                    action=action, price_changes=[("x", 1.0, 2.0)] * changes)


def test_due_after_time_and_once_a_day():
    at = datetime(2026, 10, 8, 10, 29, tzinfo=dps.MSK)
    assert not dps.is_due(at, False)
    assert dps.is_due(at.replace(minute=30), False)
    assert not dps.is_due(at.replace(minute=45), True)


def test_off_by_default(db, monkeypatch):
    monkeypatch.setattr(settings, "PRICE_CHANNEL_DAILY_SYNC", False)
    assert dps.maybe_run(db, datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc)) is None


def test_updates_only_existing_posts_and_runs_once(db, monkeypatch):
    from app.services import price_channel, staff_auth
    monkeypatch.setattr(settings, "PRICE_CHANNEL_DAILY_SYNC", True)
    monkeypatch.setattr(price_channel, "build_plan", lambda db: [
        _plan("price_macbook_air", "update", 15), _plan("price_iphone_p4", "create"),
        _plan("price_jura", "unchanged")])
    applied = {}
    def fake_apply(db, slugs=None, **kw):
        applied["slugs"] = slugs
        return ApplyResult(updated=list(slugs))
    monkeypatch.setattr(price_channel, "apply_plan", fake_apply)
    sent = []
    monkeypatch.setattr(staff_auth, "notify", lambda chat, text, **kw: sent.append(text) or True)
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_IDS", "8614709711")

    now = datetime(2026, 10, 8, 7, 31, tzinfo=timezone.utc)      # 10:31 МСК
    stats = dps.maybe_run(db, now)
    assert applied["slugs"] == ["price_macbook_air"]                # create не трогаем
    assert stats["updated"] == 1 and stats["price_lines"] == 15 and stats["create_pending"] == 1
    assert sent and "price_iphone_p4" in sent[0]
    assert db.query(AuditLog).filter_by(action=dps.ACTION).count() == 1
    assert dps.maybe_run(db, now.replace(hour=9)) is None           # второй раз за день — нет
