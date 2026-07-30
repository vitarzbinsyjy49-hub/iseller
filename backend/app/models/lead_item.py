"""Позиция заявки-корзины (снапшот товара на момент отправки).

Заявка — это ДОГОВОРЁННОСТЬ, зафиксированная во времени. Поэтому позиция
хранит собственные копии названия, артикула, цены и режима доступности, а не
ссылается на живой товар: цена в каталоге может измениться через час, товар —
исчезнуть совсем, и тогда менеджер увидит «что-то другое», а не то, что
отправил покупатель.

Отсюда ``ondelete="SET NULL"`` у ``product_id``: удаление товара в админке не
имеет права утащить за собой позиции уже отправленных заявок (в живой корзине
— наоборот, CASCADE, см. ``models/cart.py``). Ссылка теряется, снапшот
остаётся.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class LeadItem(Base):
    __tablename__ = "lead_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    lead_id: Mapped[int] = mapped_column(
        ForeignKey("leads.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Ссылка «для удобства» (открыть товар из админки). Может стать NULL —
    # заявка от этого не портится, весь смысл лежит в снапшотах ниже.
    product_id: Mapped[int | None] = mapped_column(
        ForeignKey("products.id", ondelete="SET NULL"), index=True
    )
    sku_snapshot: Mapped[str | None] = mapped_column(String(64))
    title_snapshot: Mapped[str] = mapped_column(String(300))
    price_snapshot: Mapped[float] = mapped_column(Numeric(12, 2))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    line_total: Mapped[float] = mapped_column(Numeric(12, 2))
    availability_snapshot: Mapped[str | None] = mapped_column(String(20))
    image_snapshot: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    lead = relationship("Lead", back_populates="items")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "product_id": self.product_id,
            "sku": self.sku_snapshot,
            "title": self.title_snapshot,
            "price": float(self.price_snapshot) if self.price_snapshot is not None else None,
            "quantity": self.quantity,
            "line_total": float(self.line_total) if self.line_total is not None else None,
            "availability_mode": self.availability_snapshot,
            "image": self.image_snapshot,
        }
