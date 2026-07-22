"""Канонические группы изображений (v5.2.6).

Одна строка = галерея для одной модели одного цвета. Товары с одинаковым
image_group_key (brand|model|color) используют эту галерею, независимо от
памяти/накопителя/RAM. Ключ вычисляется в app/services/image_groups.py.

Товар со своими `image`/`images` продолжает работать как раньше: группа —
дополнительный слой, resolver выбирает источник (см. image_groups.resolve_*).
"""
from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ProductImageGroup(Base):
    __tablename__ = "product_image_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(255), unique=True, index=True)  # brand|model|color
    brand: Mapped[str | None] = mapped_column(String(100))
    model: Mapped[str | None] = mapped_column(String(200))
    color: Mapped[str | None] = mapped_column(String(80))
    image: Mapped[str | None] = mapped_column(Text)              # главная (обложка группы)
    images: Mapped[list] = mapped_column(JSON, default=list)      # упорядоченная галерея URL
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
