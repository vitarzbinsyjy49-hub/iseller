"""Напоминание о брошенной корзине (патч 1.1, фича #2).

Корзина — не бронь и не оплата, поэтому напоминание здесь не «оплатите», а
«вы собрали список, отправьте заявку». Ничего не резервируется, никакой срок не
истекает, и придумывать срочность нельзя: её нет.

Критерий «заброшена» — ``carts.updated_at``. Поле для этого и заводилось:
``_touch()`` в services/cart.py помечает им КАЖДОЕ изменение состава, и его
комментарий прямо называет это «критерием заброшенности».

Одно напоминание на одно СОСТОЯНИЕ корзины — вот главное правило, и держит его
``dedupe_key = cart:{id}:{updated_at}``:

- человек ничего не трогал — ключ тот же, второго напоминания не будет НИКОГДА,
  сколько бы раз ни прогонялся скан;
- человек что-то доложил и снова бросил — ``updated_at`` новый, ключ новый,
  напоминание возможно.

Такой ключ не требует ни счётчика «сколько раз напоминали», ни поля «когда
напоминали в последний раз»: состояние корзины и есть состояние напоминания.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.cart import Cart
from app.models.user import User
from app.services.cart import cart_payload
from app.services.notification_templates import cart_reminder_message
from app.services.notifications import enqueue, notifications_enabled

logger = logging.getLogger("techshop.notifications")

#: МСК = UTC+3 круглый год (перевод часов отменён в 2014-м), поэтому обходимся
#: фиксированным сдвигом и не тянем базу часовых поясов ради одной проверки.
MOSCOW_OFFSET = timedelta(hours=3)


def is_quiet_hour(now_utc: datetime) -> bool:
    """Ночь по Москве — время, когда уведомление приносит отписку.

    Интервал задаётся как «с 22 до 10» и ПЕРЕСЕКАЕТ полночь, поэтому обычное
    ``from <= h < to`` здесь дало бы ровно обратный результат — сравнение
    развёрнуто осознанно.
    """
    quiet_from = settings.CART_REMINDER_QUIET_FROM_HOUR
    quiet_to = settings.CART_REMINDER_QUIET_TO_HOUR
    hour = (now_utc + MOSCOW_OFFSET).hour
    if quiet_from == quiet_to:
        return False
    if quiet_from < quiet_to:
        return quiet_from <= hour < quiet_to
    return hour >= quiet_from or hour < quiet_to


def find_abandoned_carts(
    db: Session, *, now: datetime, idle_hours: int | None = None,
    max_age_hours: int | None = None, limit: int = 100,
) -> list[tuple[Cart, User]]:
    """Активные корзины, пролежавшие без изменений от idle до max_age часов.

    Верхняя граница обязательна. Без неё первый же прогон на живой базе разошлёт
    напоминания по ВСЕМ корзинам, накопленным с начала времён, — люди получат
    сообщение про список, собранный полгода назад.
    """
    idle = settings.CART_REMINDER_IDLE_HOURS if idle_hours is None else idle_hours
    max_age = settings.CART_REMINDER_MAX_AGE_HOURS if max_age_hours is None else max_age_hours

    newest = now - timedelta(hours=idle)
    oldest = now - timedelta(hours=max_age)

    rows = db.execute(
        select(Cart, User)
        .join(User, User.id == Cart.user_id)
        .where(
            Cart.status == "active",
            Cart.updated_at <= newest,
            Cart.updated_at >= oldest,
        )
        .order_by(Cart.updated_at.asc())
        .limit(limit)
    ).all()
    return [(cart, user) for cart, user in rows]


def dedupe_key(cart: Cart) -> str:
    """Ключ идемпотентности напоминания — id корзины + её состояние."""
    stamp = cart.updated_at.isoformat() if cart.updated_at else "none"
    return f"cart:{cart.id}:{stamp}"


def scan(db: Session, *, now: datetime | None = None, limit: int = 100) -> dict:
    """Поставить напоминания в очередь. Возвращает счётчики для лога.

    Ничего не отправляет: отправка — дело drain() в том же тике. Скан только
    решает, кому есть что сказать.
    """
    stats = {"checked": 0, "queued": 0, "skipped": 0}
    if not (settings.CART_REMINDER_ENABLED and notifications_enabled()):
        return stats

    moment = now or datetime.now(timezone.utc)
    if is_quiet_hour(moment):
        return stats

    for cart, user in find_abandoned_carts(db, now=moment, limit=limit):
        stats["checked"] += 1
        if not user.telegram_id:
            stats["skipped"] += 1
            continue

        # Сумма и состав — тем же кодом, что видит покупатель на экране корзины
        # (актуальные цены, недоступные позиции не в сумме). Считать иначе
        # значит назвать в сообщении цену, которой в приложении нет.
        payload = cart_payload(db, user.id)
        message = cart_reminder_message(
            items_count=payload["items_count"],
            estimated_total=payload["estimated_total"],
            currency=payload["currency"],
            titles=[i["title"] for i in payload["items"] if i["orderable"]],
        )
        if message is None:
            stats["skipped"] += 1
            continue

        row = enqueue(
            db,
            chat_id=user.telegram_id,
            kind="cart_reminder",
            message=message,
            dedupe_key=dedupe_key(cart),
        )
        if row is None:
            stats["skipped"] += 1
        else:
            stats["queued"] += 1

    db.commit()
    # Логирует вызывающий код (_tick в bot_polling), и делает это всегда —
    # включая пустой результат, иначе «скан отработал, дел нет» неотличимо от
    # «скан не запускался».
    return stats
