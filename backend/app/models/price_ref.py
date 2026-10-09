"""Справочные цены поставщиков и привязки наших карточек к их строкам.

PriceRef — последняя увиденная строка прайса поставщика (BSA и т.п.): ключ,
цена, сам текст строки и когда её видели. PriceLink — «эта карточка = вот
этот ключ у этого поставщика», ставится один раз (services/price_sync).
Обе таблицы новые — их создаёт create_all.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class PriceRef(Base):
    __tablename__ = "price_refs"
    __table_args__ = (UniqueConstraint("source", "key", "line_key", name="uq_price_ref_line"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(16), index=True)        # bsa | apostl
    key: Mapped[str] = mapped_column(String(160), index=True)          # ip:/art:/txt:
    line_key: Mapped[str] = mapped_column(String(300))                 # текст строки без цены
    price: Mapped[int] = mapped_column(Integer)
    line: Mapped[str] = mapped_column(Text)
    post_id: Mapped[int | None] = mapped_column(Integer)
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class PriceLink(Base):
    __tablename__ = "price_links"
    __table_args__ = (UniqueConstraint("product_id", "source", name="uq_price_link_product_source"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(Integer, ForeignKey("products.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(16))
    key: Mapped[str] = mapped_column(String(160), index=True)
    # Текст строки на момент привязки: по нему выбирается одна из нескольких
    # строк с тем же ключом и находится строка, если поставщик поправил слово.
    line: Mapped[str | None] = mapped_column(Text)
    origin: Mapped[str] = mapped_column(String(16), default="auto")   # auto | manual | seed | healed
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
