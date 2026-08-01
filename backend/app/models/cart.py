"""Корзина пользователя (серверное хранение).

Корзина — НЕ бронь и НЕ оплата: это список выбранной техники, который
пользователь отправляет одной заявкой. Склад корзиной не трогается,
``products.stock`` не уменьшается — иначе демо-магазин начал бы «резервировать»
товар, которого никто не подтверждал.

Источник правды — сервер. Личность пользователя существующая (``users.id`` из
Telegram-авторизации), новой идентичности не заводим — как в избранном.
Инвариант: у пользователя не больше ОДНОЙ активной корзины (частичный
уникальный индекс); отправленная корзина переходит в ``converted`` и остаётся
как история, новая создаётся лениво при следующем добавлении.

``added_price`` — снапшот цены на момент добавления, а НЕ актуальная цена.
Актуальную всегда читаем из ``products.price``; расхождение показываем
пользователю («Цена обновилась»). Считать сумму по ``added_price`` нельзя:
корзина, пролежавшая неделю, покажет цену, которой уже нет.
"""
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base

CART_STATUSES = ("active", "converted", "abandoned")

# Разумный предел уникальных позиций. Не бизнес-правило, а защита от мусора:
# корзина на 500 позиций — это не покупатель.
MAX_CART_ITEMS = 50


class Cart(Base):
    __tablename__ = "carts"
    __table_args__ = (
        # Одна активная корзина на пользователя. Частичный уникальный индекс, а
        # не проверка в коде: гонка двух параллельных «добавить» иначе создаёт
        # две корзины, и половина товаров тихо теряется.
        Index(
            "uq_carts_active_user",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
            sqlite_where=text("status = 'active'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    items: Mapped[list["CartItem"]] = relationship(
        back_populates="cart", cascade="all, delete-orphan", lazy="selectin"
    )


class CartItem(Base):
    __tablename__ = "cart_items"
    __table_args__ = (
        UniqueConstraint("cart_id", "product_id", name="uq_cart_item_product"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cart_id: Mapped[int] = mapped_column(
        ForeignKey("carts.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Удалён товар в админке — позиция уходит из живой корзины (в отличие от
    # позиции уже отправленной заявки: там снапшот обязан пережить товар).
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True, nullable=False
    )
    sku: Mapped[str | None] = mapped_column(String(64))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    added_price: Mapped[float] = mapped_column(Numeric(12, 2))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    cart: Mapped[Cart] = relationship(back_populates="items")
