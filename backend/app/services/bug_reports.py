"""Приём и разбор сообщений об ошибках (модель — models/bug_report.py).

Всё, что приходит сюда, пришло из Mini App, то есть снаружи: текст обрезается,
фото — только наши загрузки, контекст — только известные короткие поля.
Уведомления ставятся в outbox той же транзакцией, что и сама запись, — как
у заявок (api/leads.py): коммитит вызывающий код.
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.uploads import URL_PREFIX
from app.models.bug_report import BUG_REPORT_STATUSES, BugReport
from app.models.user import User
from app.services import notifications
from app.services.notification_templates import bug_fixed_message, bug_report_message

#: Меньше — это «ой» и «не работает»: по такому нечего искать.
MIN_TEXT_LEN = 5
MAX_TEXT_LEN = 2000
#: Пять скриншотов описывают любую ошибку; больше — уже видеозапись.
MAX_PHOTOS = 5
#: Поля контекста, которые собирает клиент (frontend/src/lib/bugReport.ts).
#: Остальное молча отбрасывается.
CONTEXT_KEYS = ("platform", "tg_version", "viewport", "user_agent", "path")
CONTEXT_MAX_LEN = 300


class BugReportError(ValueError):
    """Сообщение нельзя принять — текст ошибки показывается человеку."""


def _clean_photos(raw) -> list[str]:
    if not isinstance(raw, list):
        return []
    prefix = URL_PREFIX + "/"
    return [u for u in raw if isinstance(u, str) and u.startswith(prefix)][:MAX_PHOTOS]


def _clean_context(raw) -> dict:
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key in CONTEXT_KEYS:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()[:CONTEXT_MAX_LEN]
    return out


def submit(db: Session, *, user: User, text: str | None,
           photos: list | None = None, context: dict | None = None) -> BugReport:
    clean = (text or "").strip()
    if len(clean) < MIN_TEXT_LEN:
        raise BugReportError("Опишите, что пошло не так, хотя бы парой слов")

    row = BugReport(
        user_id=user.id, telegram_id=user.telegram_id,
        username=user.username, name=user.first_name,
        text=clean[:MAX_TEXT_LEN],
        photos=_clean_photos(photos),
        context=_clean_context(context),
        status="new",
    )
    db.add(row)
    # flush: id нужен и в тексте алерта, и в ключе дедупликации.
    db.flush()
    _alert_owner(db, row)
    return row


def _alert_owner(db: Session, row: BugReport) -> None:
    if not notifications.notifications_enabled():
        return
    chat_id = notifications.admin_chat_id()
    if chat_id is None:
        return
    notifications.enqueue(
        db, chat_id=chat_id, kind="bug_report",
        message=bug_report_message(
            report_id=row.id, text=row.text, photos_count=len(row.photos or []),
            username=row.username, context=row.context or {},
        ),
        dedupe_key=f"bug_report:{row.id}",
    )


def set_status(db: Session, row: BugReport, status: str, *, note: str | None = None) -> BugReport:
    if status not in BUG_REPORT_STATUSES:
        raise BugReportError(f"status must be one of {BUG_REPORT_STATUSES}")
    row.status = status
    if note is not None:
        row.manager_note = note.strip() or None
    row.resolved_at = None if status == "new" else datetime.now(timezone.utc)
    if status == "fixed" and notifications.notifications_enabled():
        # Ключ без счётчика: «спасибо» — одно на сообщение, сколько бы раз его
        # ни открывали и ни закрывали заново.
        notifications.enqueue(
            db, chat_id=row.telegram_id, kind="bug_fixed",
            message=bug_fixed_message(report_id=row.id),
            dedupe_key=f"bug_report:{row.id}:fixed",
        )
    return row
