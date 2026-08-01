"""Избранное пользователя (серверное хранение, pre-launch).

Одна строка = один товар в избранном одного пользователя. Личность
пользователя — существующая (users.id из Telegram-авторизации), новой
идентичности не вводим. Пара (user_id, product_id) уникальна. FK с
ON DELETE CASCADE: удаление товара/пользователя в админке не падает на
внешнем ключе и не оставляет «висячих» избранных.

Патч 1.1 добавил ДВЕ КОЛОНКИ-ОТМЕТКИ: что именно про этот товар пользователь
от нас уже слышал. Без них «цена снизилась» не имеет смысла — снизилась
ОТНОСИТЕЛЬНО ЧЕГО? Сравнивать с ценой на момент прошлого скана нельзя: тогда
после каждого прогона цена «свежая», и одно и то же снижение либо теряется,
либо повторяется. Обе колонки nullable, NULL = «мы ещё ничего не сообщали»;
первый скан их ЗАПОЛНЯЕТ и молчит (см. services/favorite_watch.py).
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, UniqueConstraint, func
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
    # Самая низкая цена, о которой мы этому пользователю уже сообщали (или цена
    # на момент добавления в избранное). Значение только УБЫВАЕТ: при росте цены
    # отметка не поднимается — иначе колеблющаяся цена 100->90->100->90 слала бы
    # «цена снизилась!» на каждом качке, хотя человек уже знает про 90.
    notified_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    # Было ли на момент прошлого сообщения физическое наличие. Именно наличие, а
    # не «можно заказать»: «под заказ» и предзаказ тоже orderable, и объявить их
    # словами «снова в наличии» значит соврать.
    notified_in_stock: Mapped[bool | None] = mapped_column(Boolean)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
