"""События поведения пользователя для персональных рекомендаций (v5.2.6).

Отдельная структурированная таблица (не общий analytics_events): нужны
индексируемые product_id/category/event_type для быстрого скоринга. Хранит
минимум — никаких сырых initData/JWT/PII. Поисковые строки нормализованы и
ограничены по длине. Ретеншн/дедуп — на уровне записи (см. api/events.py и
services/recommendations.py): десятки одинаковых product_view за минуту не
плодятся, а рекомендации смотрят окно последних N дней.
"""
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

# Разрешённые типы (enum-allowlist; всё прочее отклоняется на входе).
EVENT_TYPES = {
    "product_view",
    "favorite_add",
    "favorite_remove",
    "lead_created",
    "category_view",
    "search",
    "recommendation_click",
}


class UserProductEvent(Base):
    __tablename__ = "user_product_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    product_id: Mapped[int | None] = mapped_column(Integer, index=True)
    event_type: Mapped[str] = mapped_column(String(32), index=True)
    category: Mapped[str | None] = mapped_column(String(100))
    query_normalized: Mapped[str | None] = mapped_column(String(120))
    source: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    __table_args__ = (
        Index("ix_upe_user_created", "user_id", "created_at"),
        Index("ix_upe_user_product", "user_id", "product_id"),
    )
