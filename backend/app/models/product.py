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

# Человекочитаемые подписи структурных колонок (стабильный порядок вывода).
_STRUCTURED_SPEC_LABELS: list[tuple[str, str]] = [
    ("brand", "Бренд"),
    ("condition", "Состояние"),
    ("color", "Цвет"),
    ("screen_size", "Экран"),
    ("cpu", "Процессор"),
    ("ram", "Оперативная память"),
    ("memory", "Память"),
    ("storage", "Накопитель"),
]

_CONDITION_RU = {"new": "Новый", "used": "Б/у", "refurbished": "Восстановленный"}


def _spec_value_to_str(v) -> str | None:
    """Значение характеристики -> строка для показа. bool -> Да/Нет,
    список -> перечисление, пустое -> None (строку не добавляем)."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "Да" if v else "Нет"
    if isinstance(v, (list, tuple)):
        parts = [p for p in (_spec_value_to_str(x) for x in v) if p]
        return ", ".join(parts) if parts else None
    s = str(v).strip()
    return s or None


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str | None] = mapped_column(String(64), index=True)   # артикул: ключ импорта и матчинга фото
    title: Mapped[str] = mapped_column(String(300))
    brand: Mapped[str | None] = mapped_column(String(100), index=True)
    category: Mapped[str | None] = mapped_column(String(100), index=True)
    subcategory: Mapped[str | None] = mapped_column(String(100))
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
    condition: Mapped[str] = mapped_column(String(20), default="new")  # new / used / refurbished
    color: Mapped[str | None] = mapped_column(String(50))
    memory: Mapped[str | None] = mapped_column(String(50))             # оперативная/встроенная, как в прайсе
    storage: Mapped[str | None] = mapped_column(String(50))
    screen_size: Mapped[str | None] = mapped_column(String(50))
    cpu: Mapped[str | None] = mapped_column(String(100))
    ram: Mapped[str | None] = mapped_column(String(50))
    # v5.2.6: канонические группы изображений (фото зависят от модели+цвета).
    model_family: Mapped[str | None] = mapped_column(String(120))  # каноническая модель (опц.; иначе выводится из title)
    image_group_detached: Mapped[bool] = mapped_column(Boolean, default=False)  # true => использовать свои фото, не групповые
    image_group_key: Mapped[str | None] = mapped_column(String(255), index=True)  # brand|model|color; пересчитывается автоматически
    source: Mapped[str] = mapped_column(String(50), default="manual")  # manual / import / seed
    description: Mapped[str | None] = mapped_column(Text)
    specs: Mapped[dict] = mapped_column(JSON, default=dict)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    image: Mapped[str | None] = mapped_column(Text)                 # главная картинка
    images: Mapped[list] = mapped_column(JSON, default=list)         # галерея: упорядоченный список URL
    url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    @property
    def discount_percent(self) -> int | None:
        """Скидка в % от old_price. Считается, не хранится: цена — источник правды."""
        try:
            if self.old_price and float(self.old_price) > float(self.price) > 0:
                return round((1 - float(self.price) / float(self.old_price)) * 100)
        except (TypeError, ValueError, ZeroDivisionError):
            pass
        return None

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
            "sku": self.sku,
            "title": self.title,
            "brand": self.brand,
            "category": self.category,
            "price": float(self.price),
            "old_price": float(self.old_price) if self.old_price is not None else None,
            "discount_percent": self.discount_percent,
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

    def _specifications(self) -> list[dict]:
        """Единый упорядоченный список характеристик [{label, value}].

        Data-driven, ничего не выдумываем — только реальные поля товара:
        1) свободные характеристики из specs (JSON, богаче и человекозаданы);
        2) структурные колонки, добавляющие НОВОЕ (бренд/состояние/цвет/экран/
           процессор/ОЗУ/память/накопитель) — без дублей уже показанных;
        3) гарантия, если задана.
        Дедуп по нормализованной подписи, пустые значения пропускаем."""
        out: list[dict] = []
        seen: set[str] = set()

        def add(label: str, value) -> None:
            s = _spec_value_to_str(value)
            label = (label or "").strip()
            if not s or not label:
                return
            key = label.lower()
            if key in seen:
                return
            seen.add(key)
            out.append({"label": label, "value": s})

        if isinstance(self.specs, dict):
            for k, v in self.specs.items():
                lab = str(k).strip()
                add(lab[:1].upper() + lab[1:] if lab else lab, v)

        for field, label in _STRUCTURED_SPEC_LABELS:
            value = getattr(self, field, None)
            if field == "condition":
                if not value or value == "new":
                    continue  # «Новый» по умолчанию — не засоряем список
                value = _CONDITION_RU.get(value, value)
            add(label, value)

        if self.warranty_months:
            add("Гарантия", f"{self.warranty_months} мес.")

        return out[:24]

    def to_detail(self) -> dict:
        """Полная карточка товара для страницы Product Details."""
        d = self.to_card()
        d.update({
            "description": self.description or "",
            "specs": self.specs or {},
            "specifications": self._specifications(),  # нормализованный список для UI
            "warranty_months": self.warranty_months,
            "condition": self.condition or "new",
            "color": self.color, "memory": self.memory, "storage": self.storage,
            "screen_size": self.screen_size, "cpu": self.cpu, "ram": self.ram,
            "subcategory": self.subcategory,
            "stock": self.stock,
            "on_sale": self.on_sale,
            "is_new": self.is_new,
            "images": self.images or [],          # галерея для карусели на витрине
        })
        return d

    def to_admin(self) -> dict:
        """Строка товара для админки."""
        return {
            "id": self.id, "sku": self.sku, "title": self.title, "brand": self.brand,
            "category": self.category, "subcategory": self.subcategory,
            "price": float(self.price), "old_price": float(self.old_price) if self.old_price is not None else None,
            "discount_percent": self.discount_percent,
            "in_stock": self.in_stock, "stock": self.stock, "is_active": self.is_active,
            "is_hot": self.is_hot, "is_available_today": self.is_available_today,
            "popularity": self.popularity, "rating": self.rating,
            # Полные поля для формы редактирования в админке (v2)
            "image": self.image, "images": self.images or [], "description": self.description,
            "specs": self.specs or {}, "tags": self.tags or [],
            "warranty_months": self.warranty_months, "condition": self.condition or "new",
            "color": self.color, "memory": self.memory, "storage": self.storage,
            "screen_size": self.screen_size, "cpu": self.cpu, "ram": self.ram,
            "source": self.source or "manual",
            "model_family": self.model_family,
            "image_group_detached": bool(self.image_group_detached),
            "image_group_key": self.image_group_key,
        }


# v5.2.6: image_group_key пересчитывается автоматически при любом сохранении
# товара (админка/импорт/сид) — чтобы группировка фото и дедуп вариантов не
# зависели от того, кто и где менял поля. Пустой/сбойный ключ -> None (товар
# просто не группируется). image_groups — чистая утилита (без импорта моделей),
# поэтому цикла импортов нет.
from sqlalchemy import event  # noqa: E402
from app.services.image_groups import product_image_group_key  # noqa: E402


@event.listens_for(Product, "before_insert", propagate=True)
@event.listens_for(Product, "before_update", propagate=True)
def _product_set_image_group_key(_mapper, _connection, target: "Product") -> None:
    try:
        target.image_group_key = product_image_group_key(target)
    except Exception:  # noqa: BLE001 — ключ вспомогательный, не роняем сохранение
        target.image_group_key = None
