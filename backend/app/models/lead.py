"""Модель заявки (Lead / OrderRequest) — сердце CRM демо.

Заявка создаётся из Mini App (кнопки «Оставить заявку», «Забронировать»,
«Написать менеджеру») и попадает в админку. Телефон/имя — то, что оставил
пользователь; telegram_id/username подтягиваются из его профиля.
"""
from datetime import datetime

from sqlalchemy import DateTime, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

LEAD_STATUSES = ("new", "in_progress", "reserved", "completed", "cancelled")
LEAD_SOURCES = ("ai", "product", "catalog", "home", "manager", "other")
DELIVERY_METHODS = ("pickup", "delivery")


class Lead(Base):
    __tablename__ = "leads"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True)
    telegram_id: Mapped[int | None] = mapped_column(Integer, index=True)
    name: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(64))
    username: Mapped[str | None] = mapped_column(String(200))
    product_id: Mapped[int | None] = mapped_column(Integer, index=True)
    product_title: Mapped[str | None] = mapped_column(String(300))
    product_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    message: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(32), default="other", index=True)
    delivery_method: Mapped[str | None] = mapped_column(String(32))  # pickup | delivery
    status: Mapped[str] = mapped_column(String(32), default="new", index=True)
    assigned_to: Mapped[str | None] = mapped_column(String(200))
    manager_comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "telegram_id": self.telegram_id,
            "name": self.name,
            "phone": self.phone,
            "username": self.username,
            "product_id": self.product_id,
            "product_title": self.product_title,
            "product_price": float(self.product_price) if self.product_price is not None else None,
            "message": self.message,
            "source": self.source,
            "delivery_method": self.delivery_method,
            "status": self.status,
            "assigned_to": self.assigned_to,
            "manager_comment": self.manager_comment,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
