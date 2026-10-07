"""Вход в режим администратора Mini App: кто может и как это подтверждается.

Схема (подробно — docs/superpowers/specs/2026-10-07-price-admin-design.md):

1. Mini App уже вошла обычным пользователем по подписи Telegram initData —
   подделать её без токена бота нельзя, поэтому telegram_id достоверен.
2. telegram_id должен быть в ADMIN_TELEGRAM_IDS (серверный .env).
3. Сервер шлёт в чат бота кнопку-диплинк с одноразовым секретом. Нажать её
   может только владелец этого Telegram-аккаунта — это второй фактор и заодно
   сигнализация: о любой попытке входа админ узнаёт сразу.
4. Подтверждённая заявка обменивается на staff-токен (тип "staff", 2 часа).

Чистые функции (allowed_ids, is_admin, parse_confirm_payload) — без базы и сети.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.staff_login import StaffLogin

logger = logging.getLogger("techshop.staff")

CONFIRM_PREFIX = "staffok_"
LOGIN_TTL = timedelta(minutes=5)
STAFF_TOKEN_TTL = timedelta(hours=2)


def allowed_ids() -> set[int]:
    raw = settings.ADMIN_TELEGRAM_IDS or settings.ADMIN_TELEGRAM_ID or ""
    ids: set[int] = set()
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if part.lstrip("-").isdigit():
            ids.add(int(part))
    return ids


def is_admin(telegram_id: int | None) -> bool:
    return telegram_id is not None and int(telegram_id) in allowed_ids()


def _hash(nonce: str) -> str:
    return hashlib.sha256(nonce.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    # sqlite в тестах возвращает naive datetime
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def confirm_link(nonce: str) -> str | None:
    bot = (settings.BOT_USERNAME or "").strip().lstrip("@")
    return f"https://t.me/{bot}?start={CONFIRM_PREFIX}{nonce}" if bot else None


def create_login(db: Session, telegram_id: int, ip: str | None) -> tuple[StaffLogin, str]:
    """Новая заявка. Возвращает (заявка, nonce) — nonce уходит только в диплинк."""
    # Прежние висящие заявки этого человека гасим: подтвердить можно только последнюю.
    for old in db.execute(select(StaffLogin).where(
            StaffLogin.telegram_id == telegram_id, StaffLogin.status == "pending")).scalars():
        old.status = "expired"
    nonce = secrets.token_urlsafe(18)          # 24 символа, влезает в лимит start=64
    row = StaffLogin(request_id=secrets.token_urlsafe(24), nonce_hash=_hash(nonce),
                     telegram_id=telegram_id, status="pending", ip=ip,
                     created_at=_now())
    db.add(row)
    db.flush()
    return row, nonce


def parse_confirm_payload(text: str | None) -> str | None:
    """«/start staffok_<nonce>» -> nonce, иначе None."""
    if not text:
        return None
    parts = text.strip().split(maxsplit=1)
    if len(parts) != 2 or parts[0].split("@")[0] != "/start":
        return None
    payload = parts[1].strip()
    if not payload.startswith(CONFIRM_PREFIX):
        return None
    nonce = payload[len(CONFIRM_PREFIX):]
    return nonce if 8 <= len(nonce) <= 56 else None


def approve(db: Session, nonce: str, from_telegram_id: int) -> str:
    """Подтверждение из бота. Возвращает исход: ok | unknown | foreign | expired."""
    row = db.execute(select(StaffLogin).where(StaffLogin.nonce_hash == _hash(nonce))).scalar_one_or_none()
    if row is None or row.status not in ("pending",):
        return "unknown"
    if int(row.telegram_id) != int(from_telegram_id):
        # Чужой аккаунт нажал чужую ссылку — заявку сразу гасим.
        row.status = "expired"
        return "foreign"
    if _now() - _aware(row.created_at) > LOGIN_TTL:
        row.status = "expired"
        return "expired"
    if not is_admin(row.telegram_id):
        row.status = "expired"
        return "foreign"
    row.status = "approved"
    row.approved_at = _now()
    return "ok"


def claim(db: Session, request_id: str, telegram_id: int) -> str:
    """Опрос из Mini App. pending | approved (и заявка гасится) | expired."""
    row = db.execute(select(StaffLogin).where(StaffLogin.request_id == request_id)).scalar_one_or_none()
    if row is None or int(row.telegram_id) != int(telegram_id):
        return "expired"
    if row.status == "pending" and _now() - _aware(row.created_at) > LOGIN_TTL:
        row.status = "expired"
    if row.status == "approved":
        row.status = "issued"            # токен по заявке выдаётся ровно один раз
        return "approved"
    return "pending" if row.status == "pending" else "expired"


def handle_bot_update(update: dict) -> str | None:
    """Обработчик для цикла бота. None — апдейт не про вход, обрабатывать дальше.

    Иначе возвращает текст ответа человеку (и сам подтверждает заявку)."""
    message = update.get("message") or {}
    nonce = parse_confirm_payload(message.get("text"))
    if nonce is None:
        return None
    sender = (message.get("from") or {}).get("id")
    if sender is None:
        return None
    from app.db.session import SessionLocal
    with SessionLocal() as db:
        outcome = approve(db, nonce, int(sender))
        db.commit()
    logger.info("вход в режим администратора: %s (tg %s)", outcome, sender)
    return {
        "ok": "✅ Вход подтверждён. Вернитесь в приложение — режим администратора откроется сам.",
        "expired": "Ссылка устарела (действует 5 минут). Запросите вход в приложении ещё раз.",
    }.get(outcome, "Эта ссылка недействительна.")


def notify(chat_id: int, text: str, button: tuple[str, str] | None = None) -> bool:
    """Прямое сообщение в личный чат через Bot API (мимо очереди: вход ждёт секунды,
    а очередь разбирается раз в цикл бота). False — не отправилось."""
    if not settings.TELEGRAM_BOT_TOKEN:
        return False
    from app.services.telegram_publisher import call
    payload: dict = {"chat_id": int(chat_id), "text": text, "parse_mode": "HTML",
                     "disable_web_page_preview": True}
    if button:
        payload["reply_markup"] = {"inline_keyboard": [[{"text": button[0], "url": button[1]}]]}
    try:
        call("sendMessage", payload)
        return True
    except Exception as exc:  # noqa: BLE001 — сеть до Telegram через WARP, причин много
        logger.warning("не удалось отправить сообщение о входе: %s", exc)
        return False
