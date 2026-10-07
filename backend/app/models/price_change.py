"""История цен: каждое изменение Product.price — одна строка.

Пишет её не вызывающий код, а слушатель сессии (services/price_history), поэтому
путь «поменял цену и забыл записать» не существует: админка сайта, импорт,
скрипты сверки и Mini App попадают сюда одинаково.

Объём ничтожный: ~100 байт на изменение, сто тысяч изменений — около 15 МБ.
Таблица новая — её создаёт create_all, ALTER не нужен.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class PriceChange(Base):
    __tablename__ = "price_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("products.id", ondelete="CASCADE"), index=True)
    old_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    new_price: Mapped[float] = mapped_column(Numeric(12, 2))
    # staff (Mini App) | admin_site | import | bsa | apostl | script | unknown
    source: Mapped[str] = mapped_column(String(32), default="unknown")
    # tg:<id> | admin:<email> | system
    actor: Mapped[str] = mapped_column(String(64), default="system")
    note: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "product_id": self.product_id,
            "old_price": float(self.old_price) if self.old_price is not None else None,
            "new_price": float(self.new_price),
            "source": self.source,
            "actor": self.actor,
            "note": self.note,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
