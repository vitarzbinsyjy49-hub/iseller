"""Избранное пользователя (серверное хранение, pre-launch).

Одна строка = один товар в избранном одного пользователя. Личность
пользователя — существующая (users.id из Telegram-авторизации), новой
идентичности не вводим. Пара (user_id, product_id) уникальна. FK с
ON DELETE CASCADE: удаление товара/пользователя в админке не падает на
внешнем ключе и не оставляет «висячих» избранных.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ProductFavorite(Base):
    __tablename__ = "product_favorites"
    __table_args__ = (
        UniqueConstraint("user_id", "product_id", name="uq_favorite_user_product"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
