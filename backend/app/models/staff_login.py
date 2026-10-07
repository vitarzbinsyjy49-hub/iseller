"""Заявки на вход в режим администратора Mini App.

Живут в базе, а не в памяти: заявку создаёт backend, а подтверждает бот —
это два разных процесса (контейнеры backend и bot).
Таблица новая — её создаёт create_all.
"""
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class StaffLogin(Base):
    __tablename__ = "staff_logins"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Публичный идентификатор заявки для опроса из Mini App.
    request_id: Mapped[str] = mapped_column(String(48), unique=True, index=True)
    # Секрет из диплинка подтверждения. Хранится только хеш: утечка базы не даёт
    # подтвердить чужую висящую заявку.
    nonce_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, index=True)
    # pending -> approved -> issued; или expired
    status: Mapped[str] = mapped_column(String(16), default="pending")
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
