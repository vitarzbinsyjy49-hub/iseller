"""Модель товара (Demo MVP).

База — интеграционная модель (Data Contract v1). Расширена демо-полями
(description, tags, is_hot, is_available_today, warranty_months) так, чтобы:
- AI Engine catalog_sync продолжал получать привычный формат (to_export);
- фронтенд рисовал единый компонент карточки (to_card);
- страница товара имела полную детализацию (to_detail).
Цены и наличие — единственный источник правды; LLM их не генерирует.
"""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    brand: Mapped[str | None] = mapped_column(String(100), index=True)
    category: Mapped[str | None] = mapped_column(String(100), index=True)
    price: Mapped[float] = mapped_column(Numeric(12, 2))
    old_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    in_stock: Mapped[bool] = mapped_column(Boolean, default=True)
    stock: Mapped[int] = mapped_column(Integer, default=0)          # число на складе (демо)
    rating: Mapped[float] = mapped_column(Float, default=0)
    popularity: Mapped[float] = mapped_column(Float, default=0)
    margin_pct: Mapped[float] = mapped_column(Float, default=0)
    is_new: Mapped[bool] = mapped_column(Boolean, default=False)
    on_sale: Mapped[bool] = mapped_column(Boolean, default=False)
    is_hot: Mapped[bool] = mapped_column(Boolean, default=False)               # «горячее предложение»
    is_available_today: Mapped[bool] = mapped_column(Boolean, default=False)   # «можно забрать сегодня»
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)             # вкл/выкл в каталоге (админка)
    warranty_months: Mapped[int] = mapped_column(Integer, default=12)
    description: Mapped[str | None] = mapped_column(Text)
    specs: Mapped[dict] = mapped_column(JSON, default=dict)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    image: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # ---- Демо-кнопки карточки: бронь и заявка вместо корзины ----
    def _buttons(self) -> list[dict]:
        if not self.in_stock:
            return [{"type": "lead", "label": "Оставить заявку", "product_id": self.id}]
        return [
            {"type": "open_product", "label": "Подробнее", "product_id": self.id},
            {"type": "reserve", "label": "Забронировать", "product_id": self.id},
            {"type": "lead", "label": "Оставить заявку", "product_id": self.id},
        ]

    def to_export(self) -> dict:
        """Формат Data Contract v1: то, что забирает Catalog Connector AI Engine."""
        return {
            "id": self.id,
            "title": self.title,
            "brand": self.brand,
            "category": self.category,
            "price": float(self.price),
            "old_price": float(self.old_price) if self.old_price is not None else None,
            "in_stock": self.in_stock,
            "rating": self.rating,
            "popularity": self.popularity,
            "margin_pct": self.margin_pct,
            "is_new": self.is_new,
            "on_sale": self.on_sale,
            "specs": self.specs or {},
            "image": self.image,
            "url": self.url,
        }

    def to_card(self) -> dict:
        """Карточка для ленты/AI-ответа/fallback — единый формат для фронтенда."""
        return {
            "id": self.id,
            "title": self.title,
            "brand": self.brand,
            "category": self.category,
            "price": float(self.price),
            "old_price": float(self.old_price) if self.old_price is not None else None,
            "in_stock": self.in_stock,
            "stock": self.stock,
            "rating": self.rating,
            "image": self.image or "",
            "url": self.url or "",
            "is_hot": self.is_hot,
            "is_available_today": self.is_available_today,
            "tags": self.tags or [],
            "why": [],
            "buttons": self._buttons(),
        }

    def to_detail(self) -> dict:
        """Полная карточка товара для страницы Product Details."""
        d = self.to_card()
        d.update({
            "description": self.description or "",
            "specs": self.specs or {},
            "warranty_months": self.warranty_months,
            "stock": self.stock,
            "on_sale": self.on_sale,
            "is_new": self.is_new,
        })
        return d

    def to_admin(self) -> dict:
        """Строка товара для админки."""
        return {
            "id": self.id, "title": self.title, "brand": self.brand, "category": self.category,
            "price": float(self.price), "old_price": float(self.old_price) if self.old_price is not None else None,
            "in_stock": self.in_stock, "stock": self.stock, "is_active": self.is_active,
            "is_hot": self.is_hot, "is_available_today": self.is_available_today,
            "popularity": self.popularity, "rating": self.rating,
            # Полные поля для формы редактирования в админке (v2)
            "image": self.image, "description": self.description,
            "specs": self.specs or {}, "tags": self.tags or [],
            "warranty_months": self.warranty_months,
        }
