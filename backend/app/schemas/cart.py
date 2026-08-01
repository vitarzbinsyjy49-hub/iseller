"""Схемы корзины и checkout.

Клиент задаёт ТОЛЬКО то, что имеет право задавать: товар, количество, свои
контакты и способ получения. Цены, доступность, суммы и статус приходят из
каталога — их в схемах нет by design (как и в ``LeadIn``).
"""
from pydantic import BaseModel, Field, field_validator

from app.services.availability import MAX_ITEM_QUANTITY


class CartItemIn(BaseModel):
    product_id: int
    quantity: int = Field(default=1, ge=1, le=MAX_ITEM_QUANTITY)


class CartQuantityIn(BaseModel):
    # 0 разрешён и означает «удалить»: шаг «−» на единице должен убирать
    # позицию, а не оставлять её в нулевом количестве.
    quantity: int = Field(ge=0, le=MAX_ITEM_QUANTITY)


class CheckoutIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=64)
    # pickup | delivery | consult. Неизвестное значение нормализуется в consult
    # («уточнить с менеджером») — самый безопасный дефолт.
    fulfillment_type: str | None = Field(default=None, max_length=32)
    comment: str | None = Field(default=None, max_length=2000)
    # Согласие на связь — обязательное и явное. Значение False (или отсутствие)
    # отклоняется на backend: галочка на клиенте не может быть единственной
    # защитой.
    consent: bool = False
    # Ключ идемпотентности генерирует клиент на КАЖДУЮ попытку отправки. Один
    # ключ = одна заявка, сколько бы раз запрос ни повторился.
    idempotency_key: str | None = Field(default=None, max_length=64)

    @field_validator("idempotency_key")
    @classmethod
    def _clean_key(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        return v or None
