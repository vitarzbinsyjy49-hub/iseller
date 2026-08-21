"""История курса USD (ЦБ РФ) — одна строка на календарный день.

Строка одновременно и «кэш» текущего значения (последняя по дате), и источник
истории для графика в шторке «Курс и цены» — отдельного in-memory TTL-кэша не
заводим, читаем таблицу напрямую. Наполняется фоновым тиком бота
(app/services/fx_rate.py::sync, вызывается из app/scripts/bot_polling.py).

Таблица создаётся через Base.metadata.create_all (новая таблица, ALTER не
нужен) — по аналогии с app/models/revoked_token.py.
"""
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Numeric, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class FxRateHistory(Base):
    __tablename__ = "fx_rate_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, unique=True, index=True)
    value: Mapped[float] = mapped_column(Numeric(10, 4))
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
