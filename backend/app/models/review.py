"""Отзыв покупателя о выполненной заявке.

Главное свойство модели — **отзыв нельзя оставить просто так**. Он всегда
привязан к заявке (`lead_id`), а заявка — к человеку и к тому, что он купил.
Отсюда бейдж «покупка подтверждена» на витрине: это не наше утверждение, а
следствие того, что иначе строка сюда не попадает. Открытая форма «оставьте
отзыв» дала бы то же место на экране, но ничего не значащее.

Модерация обязательна и по умолчанию: `status='pending'`. Витрина показывает
только `approved`. Отклонённый отзыв не удаляется — иначе человек мог бы
прислать его второй раз, а мы бы не знали, что уже решали по нему.

Одна заявка — один отзыв (`uq_reviews_lead`). Повторное открытие формы
редактирует существующий черновик, а не плодит записи.
"""
from datetime import datetime

from sqlalchemy import (
    JSON, DateTime, ForeignKey, Integer, SmallInteger, String, Text,
    UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

#: pending — ждёт модерации, approved — на витрине, rejected — отклонён.
REVIEW_STATUSES = ("pending", "approved", "rejected")

#: Оценка по пятибалльной шкале. Границы проверяются в сервисе, а не только
#: типом: значение приходит из Mini App, то есть снаружи.
RATING_MIN = 1
RATING_MAX = 5


class Review(Base):
    __tablename__ = "reviews"
    __table_args__ = (
        UniqueConstraint("lead_id", name="uq_reviews_lead"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    #: Заявка, по которой оставлен отзыв. Без неё отзыва не существует.
    lead_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("leads.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True)

    #: Товар, к которому отзыв прикрепится на витрине. Может быть пустым:
    #: в заявке бывает несколько позиций, и тогда товар выбирает покупатель,
    #: а если не выбрал — отзыв живёт только в общей ленте.
    product_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("products.id", ondelete="SET NULL"), index=True)

    #: Подпись под отзывом. Хранится СНИМКОМ, а не берётся из профиля: человек
    #: соглашался публиковать конкретное имя, и смена имени в Telegram не
    #: должна менять уже опубликованный отзыв.
    author_name: Mapped[str | None] = mapped_column(String(120))

    rating: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    text: Mapped[str | None] = mapped_column(Text)
    #: Список URL наших загрузок (/api/uploads/...), как у товара.
    photos: Mapped[list] = mapped_column(JSON, default=list)

    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    #: Почему отклонён — видно только в админке, покупателю не показывается.
    moderator_note: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    #: Когда отзыв попал на витрину. Пусто, пока не одобрен.
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def to_public(self) -> dict:
        """То, что видит покупатель. Ни заявки, ни user_id здесь нет: это чужие
        персональные данные, а на витрине они ничего не объясняют."""
        return {
            "id": self.id,
            "product_id": self.product_id,
            "author_name": self.author_name or "Покупатель",
            "rating": self.rating,
            "text": self.text or "",
            "photos": list(self.photos or []),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            # Подтверждение покупки — не украшение: строка существует только
            # вместе с заявкой, поэтому флаг всегда true и всегда честен.
            "verified": True,
        }

    def to_admin(self) -> dict:
        return {
            **self.to_public(),
            "lead_id": self.lead_id,
            "user_id": self.user_id,
            "status": self.status,
            "moderator_note": self.moderator_note,
            "published_at": self.published_at.isoformat() if self.published_at else None,
        }
