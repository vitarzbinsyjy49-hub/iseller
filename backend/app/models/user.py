from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str | None] = mapped_column(String(128))
    last_name: Mapped[str | None] = mapped_column(String(128))
    # Ссылка на аватар из Telegram initData. Присылается не всегда — у
    # закрытого профиля или профиля без фото поля просто нет. NULL — сигнал
    # витрине показать инициалы вместо <img>, а не то, что аватар не загрузился.
    photo_url: Mapped[str | None] = mapped_column(String(512))
    role: Mapped[str] = mapped_column(String(16), default="customer")  # customer | admin
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
