"""Промокоды и журнал их применений.

Поля ``used_count`` на промокоде НЕТ и заводить его нельзя — по той же причине,
по которой на ``users`` нет баланса баллов: денормализованный счётчик расходится
с журналом молча, а находится это на глазах у покупателя («код кончился», хотя
он не кончился, или наоборот). Расход всегда считается из ``promo_redemptions``.

Журнал отвечает и на вопрос, который владелец задаст первым: «кто забрал мои
двадцать купонов?». Без строк на него нечем ответить.
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

#: Предел длины кода. Короткий код набирают с телефона, длинный не набирают вовсе.
MAX_CODE_LENGTH = 32


class PromoCode(Base):
    __tablename__ = "promo_codes"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Код хранится в ВЕРХНЕМ регистре и сравнивается тоже в верхнем: человек
    # набирает «start20» и «START20», имея в виду одно и то же.
    code: Mapped[str] = mapped_column(String(MAX_CODE_LENGTH), unique=True, index=True)
    # Скидка фиксированной суммой. Процент осознанно не заводим: на технике за
    # 300 000 ₽ он даёт непредсказуемый расход, а потолок скидки — это ещё одно
    # поле и ещё одно правило.
    discount_amount: Mapped[float] = mapped_column(Numeric(12, 2))
    # Сколько всего раз кодом можно воспользоваться. NULL = без ограничения.
    max_redemptions: Mapped[int | None] = mapped_column(Integer)
    # Порог корзины, ниже которого код не применяется. NULL = без порога.
    min_order_amount: Mapped[float | None] = mapped_column(Numeric(12, 2))
    # NULL = бессрочно.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Заметка владельца: зачем этот код. В UI покупателя не показывается.
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    def to_dict(self, *, used: int = 0) -> dict:
        """``used`` приходит снаружи: считать его здесь означало бы запрос на
        каждую строку списка."""
        return {
            "id": self.id,
            "code": self.code,
            "discount_amount": float(self.discount_amount),
            "max_redemptions": self.max_redemptions,
            "min_order_amount": (
                float(self.min_order_amount) if self.min_order_amount is not None else None
            ),
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "is_active": self.is_active,
            "note": self.note,
            "used": used,
            "left": None if self.max_redemptions is None else max(0, self.max_redemptions - used),
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class PromoRedemption(Base):
    __tablename__ = "promo_redemptions"
    __table_args__ = (
        # «Один раз на аккаунт» держит БАЗА, а не проверка в коде: проверку
        # обходит гонка двух одновременных оформлений, уникальный индекс — нет.
        UniqueConstraint("promo_id", "user_id", name="uq_promo_redemption_user"),
        Index("ix_promo_redemptions_promo", "promo_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    promo_id: Mapped[int] = mapped_column(
        ForeignKey("promo_codes.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    # Заявку могут удалить, а факт расхода купона от этого не исчезает —
    # SET NULL, как у позиций уже отправленной заявки.
    lead_id: Mapped[int | None] = mapped_column(
        ForeignKey("leads.id", ondelete="SET NULL")
    )
    # Снапшоты на момент применения. Через полгода нужно знать, сколько сняли
    # тогда, а не сколько сняли бы по сегодняшним настройкам кода — то же
    # правило, что у added_price в корзине и rate_bps в баллах.
    discount_amount: Mapped[float] = mapped_column(Numeric(12, 2))
    order_total: Mapped[float] = mapped_column(Numeric(12, 2))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "promo_id": self.promo_id,
            "user_id": self.user_id,
            "lead_id": self.lead_id,
            "discount_amount": float(self.discount_amount),
            "order_total": float(self.order_total),
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
