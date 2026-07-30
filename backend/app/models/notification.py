"""Очередь исходящих уведомлений пользователю (outbox, патч 1.1).

Зачем таблица, а не «отправить прямо здесь». Уведомление рождается внутри
HTTP-запроса (менеджер сменил статус заявки) или внутри фонового скана
(корзина заброшена), а отправка идёт в Telegram — через WARP-прокси, секунды,
иногда с ошибкой. Если отправлять по месту:

- менеджер в админке ждёт Telegram, чтобы сменить статус;
- падение Telegram превращается в падение CRM;
- уведомление, не ушедшее из-за сетевого сбоя, потеряно навсегда.

Поэтому producer пишет строку в ЭТУ таблицу той же транзакцией, что и само
событие, а отправкой занимается consumer (сервис `bot`, см. services/
notifications.py). Событие и намерение уведомить фиксируются вместе — либо оба,
либо ни одного.

``dedupe_key`` уникален и обязателен. Это единственная защита от повторов:
двойной PATCH статуса, второй прогон скана корзин, ретрай после таймаута — всё
это пытается создать вторую строку с тем же ключом и получает отказ БД. Правило
то же, что у ``idempotency_key`` заявки: уникальность обеспечивает база, а не
проверка «сначала посмотрим, нет ли уже».
"""
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

#: pending — ждёт отправки; sent — ушло; failed — отправлять больше не будем.
NOTIFICATION_STATUSES = ("pending", "sent", "failed")

#: Виды уведомлений. Нужны для метрик и для того, чтобы можно было выключить
#: один вид, не трогая остальные.
NOTIFICATION_KINDS = ("lead_status", "cart_reminder", "favorite_price")

#: Сколько раз пробуем отправить, прежде чем признать доставку несостоявшейся.
#: Считаются ТОЛЬКО временные ошибки: постоянные (бот заблокирован) уводят
#: строку в failed сразу, без ожидания попыток.
MAX_ATTEMPTS = 5


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    # chat_id личного чата = telegram_id пользователя. BigInteger — id Telegram
    # давно не помещаются в int32.
    chat_id: Mapped[int] = mapped_column(BigInteger, index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # Клавиатура в формате Bot API (список рядов). NULL — сообщение без кнопок.
    keyboard: Mapped[list | None] = mapped_column(JSON)
    dedupe_key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    # Причина последнего отказа. Хранится ИМЕННО в строке, а не только в логе:
    # молчаливая деградация — самый дорогой вид отказа, и «почему не дошло»
    # должно быть видно там же, где видно «не дошло».
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "chat_id": self.chat_id,
            "kind": self.kind,
            "text": self.text,
            "keyboard": self.keyboard,
            "dedupe_key": self.dedupe_key,
            "status": self.status,
            "attempts": self.attempts or 0,
            "last_error": self.last_error,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "sent_at": self.sent_at.isoformat() if self.sent_at else None,
        }
