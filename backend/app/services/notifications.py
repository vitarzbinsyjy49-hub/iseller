"""Outbox уведомлений: постановка в очередь и отправка (патч 1.1).

Разделение обязанностей ровно одно и оно важно:

- ``enqueue()`` вызывается ТАМ, ГДЕ ПРОИСХОДИТ СОБЫТИЕ (смена статуса заявки,
  скан брошенных корзин) и в ТОЙ ЖЕ транзакции. Сети не касается вообще;
- ``drain()`` вызывается ОДНИМ фоновым процессом (сервис ``bot``) и только он
  ходит в Telegram.

Почему не отправлять сразу — см. docstring модели (`models/notification.py`).

Гарантия доставки — at-least-once, и это осознанно. Строка помечается ``sent``
ПОСЛЕ фактической отправки: если процесс умрёт в этом промежутке, сообщение
уйдёт повторно при следующем запуске. Обратный порядок («пометить, потом
отправить») дал бы at-most-once — то есть тихую потерю уведомления, что для
покупателя, ждущего ответа по заявке, хуже, чем один дубль.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.notification import MAX_ATTEMPTS, Notification
from app.services.notification_templates import Message
from app.services.telegram_publisher import (
    TelegramPublishError,
    TelegramRateLimited,
    call,
)

logger = logging.getLogger("techshop.notifications")

#: Ошибки Telegram, которые повтором не лечатся. Человек заблокировал бота или
#: никогда его не запускал — сообщение не дойдёт ни сейчас, ни через час, ни
#: через пять попыток. Держать такую строку в очереди значит гарантированно
#: тратить попытки и место, поэтому уводим в failed сразу.
_PERMANENT_MARKERS = (
    "chat not found",
    "bot was blocked",
    "user is deactivated",
    "bot can't initiate conversation",
    "peer_id_invalid",
    "chat_id is empty",
    "user not found",
    # Сломанная разметка — дефект текста, а не сети: пять повторов дадут пять
    # одинаковых отказов. Причина обычно одна — неэкранированное «&» или «<»
    # в названии товара (см. escape в notification_templates).
    "can't parse entities",
    "message text is empty",
)


def _is_permanent(description: str) -> bool:
    text = (description or "").lower()
    return any(marker in text for marker in _PERMANENT_MARKERS)


# ------------------------------------------------------------- producer ----
def enqueue(
    db: Session, *, chat_id: int | None, kind: str, message: Message | None,
    dedupe_key: str,
) -> Notification | None:
    """Поставить уведомление в очередь. None — «ставить нечего или уже стоит».

    НЕ коммитит: строка обязана уехать той же транзакцией, что и событие,
    которое её породило. Коммитит вызывающий код.

    Три причины вернуть None, и все три — норма, а не сбой:
      1. ``message is None`` — шаблон решил, что сообщать не о чем;
      2. ``chat_id`` пуст — заявка не из Telegram, писать некому;
      3. дубль по ``dedupe_key`` — об этом мы уже сообщали.

    Дубль ловится ОТКАТОМ ДО SAVEPOINT, а не предварительной проверкой
    «select, потом insert»: между проверкой и вставкой помещается второй
    запрос, и тогда дубль всё равно проходит. Уникальность держит БД.
    """
    if message is None or not chat_id:
        return None

    row = Notification(
        chat_id=int(chat_id),
        kind=kind,
        text=message.text,
        keyboard=message.keyboard or None,
        dedupe_key=dedupe_key,
        status="pending",
        attempts=0,
    )
    try:
        with db.begin_nested():
            db.add(row)
        return row
    except IntegrityError:
        # Уже поставлено — это ожидаемый исход повторного вызова, не ошибка.
        logger.debug("уведомление %s уже в очереди", dedupe_key)
        return None


# ------------------------------------------------------------- consumer ----
def _send(row: Notification) -> None:
    """Фактическая отправка в ЛИЧНЫЙ чат.

    Payload собираем здесь, а не через publisher.send_message, хотя тот и умеет
    принимать chat_id. Причина в его подстраховке: пустой адресат он подменяет
    на TELEGRAM_CHANNEL_ID — разумно для постов канала и катастрофично здесь.
    Уведомление про заявку — это имя, состав и сумма конкретного человека;
    промах адресата опубликовал бы их в открытом канале. Такой ошибки не должно
    быть даже теоретически, поэтому fallback'а на канал в этом пути просто нет.

    Retry-слой (429, сетевые сбои) при этом общий — call() из publisher.
    """
    if not row.chat_id:
        raise TelegramPublishError("chat_id is empty")
    payload: dict = {
        "chat_id": int(row.chat_id),
        "text": row.text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if row.keyboard:
        payload["reply_markup"] = {"inline_keyboard": row.keyboard}
    call("sendMessage", payload)


def drain(db: Session, *, limit: int = 20, send=None) -> dict:
    """Отправить накопившиеся уведомления. Возвращает счётчики для лога.

    Коммит — ПОСЛЕ КАЖДОЙ строки, а не одним пакетом в конце: сбой на пятом
    сообщении не должен откатывать четыре уже отправленных (они уже у
    пользователя, и повторить их — значит прислать дубль).

    Исключение наружу не выпускаем ни при каких обстоятельствах: drain крутится
    внутри цикла бота, и упавший drain остановил бы приём сообщений — то есть
    уведомления сломали бы сам бот.
    """
    sender = send or _send
    stats = {"sent": 0, "failed": 0, "retry": 0}

    rows = db.execute(
        select(Notification)
        .where(Notification.status == "pending", Notification.attempts < MAX_ATTEMPTS)
        .order_by(Notification.id.asc())
        .limit(limit)
    ).scalars().all()

    for row in rows:
        row.attempts = (row.attempts or 0) + 1
        try:
            sender(row)
        except TelegramRateLimited as exc:
            # Лимит — временное состояние: оставляем pending, попробуем в
            # следующем тике. Попытку при этом засчитываем, иначе строка с
            # вечным 429 крутилась бы бесконечно.
            row.last_error = f"rate limited, retry after {exc.retry_after}s"
            stats["retry"] += 1
            logger.info("уведомление %s: лимит Telegram", row.dedupe_key)
        except TelegramPublishError as exc:
            description = str(exc)
            row.last_error = description[:500]
            if _is_permanent(description) or row.attempts >= MAX_ATTEMPTS:
                row.status = "failed"
                stats["failed"] += 1
                logger.warning("уведомление %s не доставлено: %s", row.dedupe_key, description)
            else:
                stats["retry"] += 1
                logger.info("уведомление %s: повтор (%s)", row.dedupe_key, description)
        except Exception as exc:  # noqa: BLE001 — одно плохое уведомление не роняет очередь
            row.last_error = str(exc)[:500]
            if row.attempts >= MAX_ATTEMPTS:
                row.status = "failed"
                stats["failed"] += 1
            else:
                stats["retry"] += 1
            logger.exception("уведомление %s: неожиданная ошибка", row.dedupe_key)
        else:
            row.status = "sent"
            row.sent_at = datetime.now(timezone.utc)
            row.last_error = None
            stats["sent"] += 1

        try:
            db.commit()
        except Exception:  # noqa: BLE001
            logger.exception("не удалось сохранить состояние уведомления %s", row.dedupe_key)
            db.rollback()

    return stats


def notifications_enabled() -> bool:
    """Общий рубильник. Без токена бота отправлять всё равно нечем — тогда и
    ставить в очередь незачем: очередь копила бы сообщения, которые никогда не
    уйдут, и первый же запуск с токеном вывалил бы на людей всю историю."""
    return bool(settings.NOTIFICATIONS_ENABLED and settings.TELEGRAM_BOT_TOKEN)
