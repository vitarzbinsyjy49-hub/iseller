"""Модель заявки (Lead / OrderRequest) — сердце CRM демо.

Заявка создаётся из Mini App (кнопки «Оставить заявку», «Забронировать»,
«Написать менеджеру») и попадает в админку. Телефон/имя — то, что оставил
пользователь; telegram_id/username подтягиваются из его профиля.
"""
from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, Index, Integer, Numeric, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base

# Статусы РАСШИРЕНЫ аддитивно (Compact Home + Cart): три новых значения из
# воронки подтверждения корзины встают рядом со старыми пятью. Заводить второй
# словарь статусов для того же поля нельзя — админка и витрина читают один
# список, и расхождение здесь означает заявку с непонятным статусом.
LEAD_STATUSES = (
    "new", "contacted", "confirming", "confirmed",
    "in_progress", "reserved", "completed", "cancelled",
)
# telegram_mini_app_cart — источник общей заявки из корзины Mini App.
LEAD_SOURCES = ("ai", "product", "catalog", "home", "manager", "telegram_mini_app_cart", "other")
# consult — «уточнить с менеджером»: третий способ получения появился вместе с
# checkout корзины (раньше выбор был только самовывоз/доставка).
DELIVERY_METHODS = ("pickup", "delivery", "consult")

# v5.4.0: тип сценарной заявки. Хранится ОТДЕЛЬНО от source (канал происхождения):
# source остаётся "home"/"product"/"ai"/…, а lead_type задаёт продуктовый сценарий.
# Обратная совместимость: старый POST без lead_type -> "general" (см. миграцию/схему).
# cart — общая заявка по корзине: несколько позиций в lead_items.
# price_offer — «нашли дешевле»: покупатель прислал ссылку на тот же товар у
# конкурента, менеджер решает по цене вручную. Ссылка и цена со слов покупателя
# лежат в metadata; наша цена — в снапшоте product_price самой заявки.
# sell_item — «Предложить товар»: пользователь предлагает магазину свою б/у
# технику с фото и желаемой ценой (metadata.category/title/state/price_wanted/
# photos), после модерации становится товаром с source="user_submitted" в
# изолированном разделе «Маркетплейс» (см. services/marketplace.py).
LEAD_TYPES = ("general", "product", "trade_in", "b2b", "wholesale", "cart", "price_offer", "sell_item")
DEFAULT_LEAD_TYPE = "general"
CART_LEAD_TYPE = "cart"
CART_LEAD_SOURCE = "telegram_mini_app_cart"


class Lead(Base):
    __tablename__ = "leads"
    __table_args__ = (
        # Частичный уникальный индекс: пары (пользователь, ключ) уникальны, а
        # NULL-ключи старых одиночных заявок под ограничение не попадают вовсе.
        Index(
            "uq_leads_user_idempotency",
            "user_id", "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
            sqlite_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True)
    # BigInteger, как у users.telegram_id: Telegram уже выдаёт id за пределами
    # 32-битного INTEGER (например 7678374811) — заявка падала на INSERT.
    telegram_id: Mapped[int | None] = mapped_column(BigInteger, index=True)
    name: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(64))
    username: Mapped[str | None] = mapped_column(String(200))
    product_id: Mapped[int | None] = mapped_column(Integer, index=True)
    #: Что человек купил ПО ФАКТУ, если это не то, с чего он начал.
    #:
    #: Снапшот выше не трогаем никогда: он показывает, что покупатель реально
    #: отправил, и «просил наушники с шумоподавлением, а взял обычные» — это
    #: сведения о том, что витрина сравнила не то. Затерев product_id, мы бы
    #: стёрли ровно тот факт, который стоит замечать.
    #:
    #: Пусто, пока менеджер не сказал иначе; тогда действует снапшот.
    purchased_product_id: Mapped[int | None] = mapped_column(Integer, index=True)
    product_title: Mapped[str | None] = mapped_column(String(300))
    product_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    message: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(32), default="other", index=True)
    # v5.4.0: продуктовый сценарий заявки (general/product/trade_in/b2b/wholesale).
    # Атрибут назван lead_type; тип хранится отдельно от source.
    lead_type: Mapped[str] = mapped_column(String(32), default=DEFAULT_LEAD_TYPE, index=True)
    # v5.4.0: структурированные ответы сценария. Атрибут `meta`, т.к. `metadata`
    # зарезервировано в declarative Base; DB-колонка и JSON-ключ ответа — "metadata".
    meta: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    delivery_method: Mapped[str | None] = mapped_column(String(32))  # pickup | delivery | consult
    # ---- Заявка из корзины (все поля необязательные) ----
    # Одиночные заявки их не заполняют и продолжают работать без изменений:
    # items_count=0, estimated_total=NULL, позиций в lead_items нет.
    items_count: Mapped[int] = mapped_column(Integer, default=0)
    estimated_total: Mapped[float | None] = mapped_column(Numeric(12, 2))
    # Фактическая сумма сделки — то, что менеджер подтвердил при завершении.
    # НЕ значение по умолчанию от estimated_total: админка подставляет оценку
    # в форму подсказкой, но в базу попадает подтверждённое. Совпадение полей
    # тогда означает «менеджер согласился», а не «никто не смотрел».
    final_total: Mapped[float | None] = mapped_column(Numeric(12, 2))
    # Сколько раз заявка входила в статус «завершена». Участвует в ключе
    # идемпотентности начислений: без него повторное завершение после отката
    # вернуло бы старую операцию вместо новой и не начислило бы ничего — молча.
    completion_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    currency: Mapped[str | None] = mapped_column(String(8), default="RUB")
    # Ключ идемпотентности checkout: повторная отправка той же корзины (двойной
    # тап, ретрай после таймаута) обязана вернуть ТУ ЖЕ заявку, а не создать
    # вторую. Уникальность обеспечивает БД, а не проверка «сначала посмотрим»,
    # и она СОСТАВНАЯ — (user_id, ключ). Глобальный уникальный ключ означал бы,
    # что чужой клиент может занять значение и сломать checkout другому.
    idempotency_key: Mapped[str | None] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32), default="new", index=True)
    assigned_to: Mapped[str | None] = mapped_column(String(200))
    manager_comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Позиции заявки-корзины. lazy="selectin" — один дополнительный запрос на
    # выборку, а не N+1 на список из сотни заявок в админке.
    items = relationship(
        "LeadItem", back_populates="lead", cascade="all, delete-orphan",
        lazy="selectin", order_by="LeadItem.id",
    )

    @property
    def public_number(self) -> str:
        """Номер заявки для человека. Отдельного счётчика не заводим: id уже
        уникален и стабилен, а второй номер пришлось бы синхронизировать."""
        return f"№{self.id}"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "public_number": self.public_number,
            "user_id": self.user_id,
            "telegram_id": self.telegram_id,
            "name": self.name,
            "phone": self.phone,
            "username": self.username,
            "product_id": self.product_id,
            "purchased_product_id": self.purchased_product_id,
            "product_title": self.product_title,
            "product_price": float(self.product_price) if self.product_price is not None else None,
            "message": self.message,
            "source": self.source,
            "lead_type": self.lead_type or DEFAULT_LEAD_TYPE,
            "metadata": self.meta or {},
            "delivery_method": self.delivery_method,
            "items_count": self.items_count or 0,
            "estimated_total": float(self.estimated_total) if self.estimated_total is not None else None,
            "final_total": float(self.final_total) if self.final_total is not None else None,
            "completion_seq": self.completion_seq or 0,
            "currency": self.currency or "RUB",
            "items": [i.to_dict() for i in (self.items or [])],
            "status": self.status,
            "assigned_to": self.assigned_to,
            "manager_comment": self.manager_comment,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
