"""Журнал операций с баллами — ЕДИНСТВЕННЫЙ источник правды о лояльности.

Полей ``balance``/``lifetime_spent`` на ``users`` НЕТ и заводить их нельзя:
денормализованная копия агрегата разъезжается с журналом молча, и находится это
на глазах у клиента. Баланс и оборот всегда считаются из этих строк
(``services/loyalty.py``), а при сотнях пользователей это один GROUP BY по
индексу.

Журнал отвечает ещё и на вопрос, который менеджеру задают всегда: «откуда у него
3000 баллов?». Без истории на него нечем ответить, а откатить ошибочное
начисление — нечем вдвойне.
"""
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

# purchase   — покупка: есть amount, баллы начисляются по ставке уровня
# spend      — списание баллов менеджером при сделке
# bonus      — подарочное начисление (акция, извинение, компенсация)
# correction — явная правка ошибки, комментарий обязателен
# referral   — автоматическая выплата реферальной программы: процент
#              пригласившему и приветственные баллы приглашённому. Отдельно от
#              bonus: bonus — ручной подарок менеджера, и в отчёте это разные
#              статьи расходов.
LOYALTY_KINDS = ("purchase", "spend", "bonus", "correction", "referral")

# Виды, для которых комментарий обязателен. Списание и правка баланса без
# объяснения — это ровно та строка, из-за которой потом никто не может понять,
# что произошло.
COMMENT_REQUIRED = ("spend", "correction")


class LoyaltyTransaction(Base):
    __tablename__ = "loyalty_transactions"
    __table_args__ = (
        # Идемпотентность В ПРЕДЕЛАХ пользователя — тем же приёмом, что
        # uq_leads_user_idempotency. Глобально уникальный ключ позволил бы
        # чужому клиенту занять значение и сломать начисление соседу.
        Index(
            "uq_loyalty_user_idempotency",
            "user_id", "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
            sqlite_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # CASCADE: нет пользователя — нет и его баллов. В отличие от lead_items,
    # переживать владельца этим строкам незачем: они и есть его счёт.
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    kind: Mapped[str] = mapped_column(String(16), index=True)
    # СО ЗНАКОМ: начисление +, списание −. Баланс — просто SUM, без разбора
    # видов операции; отдельная колонка «направление» дала бы второе, способное
    # разойтись со знаком, определение того же самого.
    points: Mapped[int] = mapped_column(Integer)
    # Сумма покупки. Только у kind='purchase', иначе NULL: оборот считается
    # именно по покупкам, и подарочный бонус не имеет права его двигать.
    amount: Mapped[float | None] = mapped_column(Numeric(12, 2))
    # Ставка в сотых процента (25 = 0,25%) на момент операции. Снапшот, как
    # added_price у корзины: через полгода нужно знать, по какой ставке
    # начислили, а не по какой начислили бы сегодня.
    rate_bps: Mapped[int | None] = mapped_column(Integer)
    comment: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(200))
    idempotency_key: Mapped[str | None] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "points": self.points,
            "amount": float(self.amount) if self.amount is not None else None,
            "rate_bps": self.rate_bps,
            "comment": self.comment,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
