"""Запись и чтение первого касания рекламной ссылки в чате с ботом.

Два потребителя:

- бот (`app/scripts/bot_polling.py`, `app/api/telegram.py`) — на `/start` с
  рекламным payload'ом зовёт `remember_from_update`;
- `app/api/auth.py::_get_or_create_user` — при СОЗДАНИИ пользователя зовёт
  `slug_for`, если метка не пришла в `start_param`.

Приоритет остаётся за `start_param`: он точнее (приходит в том же запросе, что
и логин) и не зависит от того, дожил ли чат с ботом до открытия приложения.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.models.ad_touch import AdTouch
from app.services.telegram_bot import parse_ad_payload, parse_ref_payload, parse_start_payload

logger = logging.getLogger("techshop.ad_touch")


def slug_for(db, telegram_id: int, kind: str = "ad") -> str | None:
    """Метка первого касания этого вида для этого telegram_id, или None.

    Вид спрашивается явно: строка одна на человека, и реферальное касание не
    имеет права прочитаться как рекламный источник — иначе чужой код осел бы в
    отчёте по каналам как кампания.
    """
    try:
        return db.execute(
            select(AdTouch.slug).where(
                AdTouch.telegram_id == int(telegram_id),
                AdTouch.kind == kind,
            )
        ).scalar_one_or_none()
    except (TypeError, ValueError):
        return None


def _has_touch(db, telegram_id: int) -> bool:
    """Есть ли у человека касание ЛЮБОГО вида.

    Проверка нарочно без вида: строка одна на telegram_id (unique index), и
    первое касание есть первое касание — реферальная ссылка не перебивает
    рекламную, как и наоборот.
    """
    return db.execute(
        select(AdTouch.id).where(AdTouch.telegram_id == int(telegram_id))
    ).scalar_one_or_none() is not None


def remember(db, telegram_id: int, slug: str, kind: str = "ad") -> bool:
    """Записать первое касание. True — если строка появилась именно сейчас.

    Первое касание НЕ перезаписывается: если строка уже есть, вторая рекламная
    ссылка молча ничего не меняет — это тот же инвариант, что и у
    `acquisition_source`, только на шаг раньше.

    Гонку двух `/start` подряд ловит уникальный индекс, а не проверка перед
    вставкой: между SELECT и INSERT успевает вклиниться параллельный процесс.
    IntegrityError здесь означает «кто-то записал первым» — то есть ровно то,
    чего мы и хотели, поэтому это не ошибка.
    """
    try:
        telegram_id = int(telegram_id)
    except (TypeError, ValueError):
        return False
    if _has_touch(db, telegram_id):
        return False
    db.add(AdTouch(telegram_id=telegram_id, slug=slug, kind=kind))
    try:
        db.commit()
    except SQLAlchemyError:
        # Уникальный индекс отработал (или таблицы ещё нет — деплой в процессе).
        # Откатываемся, чтобы сессия осталась пригодной: в том же запросе после
        # нас идёт отправка ответа боту, и она не имеет права упасть из-за
        # аналитики.
        db.rollback()
        return False
    return True


def remember_from_update(db, update: dict) -> str | None:
    """Разобрать апдейт Telegram и записать касание, если это рекламный /start.

    Возвращает метку, если строка появилась именно сейчас, иначе None.

    Best-effort по построению: аналитика не имеет права помешать человеку
    получить ответ бота, поэтому любая ошибка здесь гасится и логируется.
    Отсюда же и общий вход для обоих транспортов (long polling и вебхук) —
    иначе один из них тихо перестал бы писать источник.
    """
    try:
        message = update.get("message") or {}
        if not isinstance(message, dict):
            return None
        if (message.get("chat") or {}).get("type") != "private":
            return None
        payload = parse_start_payload(message.get("text"))
        if not payload:
            return None
        # Реферальная ссылка идёт тем же конвейером: касание одно, различается
        # только вид — во что метка превратится при логине.
        kind = "ad"
        slug = parse_ad_payload(payload)
        if slug is None:
            slug = parse_ref_payload(payload)
            kind = "ref"
        if slug is None:
            return None
        # id пользователя, а не чата: в личке они совпадают, но from — это тот,
        # кто нажал, и именно по нему потом ищет _get_or_create_user.
        sender = message.get("from") or {}
        telegram_id = sender.get("id") if isinstance(sender, dict) else None
        if telegram_id is None:
            telegram_id = (message.get("chat") or {}).get("id")
        if telegram_id is None:
            return None
        return slug if remember(db, telegram_id, slug, kind=kind) else None
    except Exception:  # noqa: BLE001 — атрибуция не роняет ответ бота
        logger.exception("не удалось записать первое касание рекламы")
        return None
