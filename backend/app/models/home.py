"""Управляемая главная (v4): hero-баннеры и кнопки категорий.

Раньше баннеры/категории были захардкожены во фронтенде. Теперь ими управляет
админ: порядок (position), вкл/выкл (is_active), картинка/градиент, действие.

action_type определяет, куда ведёт клик на витрине:
- category   -> /catalog?category=<action_value>
- search     -> /catalog?query=<action_value>
- product    -> /product/<action_value>
- collection -> /catalog?collection=<action_value>  (hot|today|sale)
- ai         -> /ai?q=<action_value>
- external   -> открыть ссылку action_value
"""
from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

ACTION_TYPES = ("category", "search", "product", "collection", "ai", "external")


class HomeBanner(Base):
    __tablename__ = "home_banners"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(120))
    subtitle: Mapped[str | None] = mapped_column(String(200))
    emoji: Mapped[str | None] = mapped_column(String(16))            # быстрый визуал без картинки
    image_url: Mapped[str | None] = mapped_column(Text)
    background_gradient: Mapped[str | None] = mapped_column(String(200))  # CSS-градиент или hex
    action_type: Mapped[str] = mapped_column(String(20), default="search")
    action_value: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "title": self.title, "subtitle": self.subtitle,
            "emoji": self.emoji, "image_url": self.image_url,
            "background_gradient": self.background_gradient,
            "action_type": self.action_type, "action_value": self.action_value,
            "position": self.position, "is_active": self.is_active,
        }


class HomeCategory(Base):
    __tablename__ = "home_categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(60))
    emoji: Mapped[str | None] = mapped_column(String(16))
    icon_url: Mapped[str | None] = mapped_column(Text)
    background_gradient: Mapped[str | None] = mapped_column(String(200))
    action_type: Mapped[str] = mapped_column(String(20), default="category")
    action_value: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "title": self.title, "emoji": self.emoji,
            "icon_url": self.icon_url, "background_gradient": self.background_gradient,
            "action_type": self.action_type, "action_value": self.action_value,
            "position": self.position, "is_active": self.is_active,
        }
