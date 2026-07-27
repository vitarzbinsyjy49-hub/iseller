"""Отозванные refresh-токены (v5.4.2).

Refresh-токен одноразовый: при обмене на новую пару его jti попадает сюда, и
повторно использовать его уже нельзя. Это ограничивает окно для украденного
токена одним запросом вместо REFRESH_TOKEN_DAYS.

Таблица создаётся через Base.metadata.create_all (новая таблица, ALTER не нужен).
Строки старше expires_at бесполезны (сам JWT уже протух) и подчищаются на лету.
"""
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class RevokedRefreshToken(Base):
    __tablename__ = "revoked_refresh_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    jti: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    subject: Mapped[str] = mapped_column(String(64), index=True)
    # момент, после которого запись можно удалять (= exp исходного токена)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
