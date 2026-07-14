"""Схемы Integration Layer: AI-чат, события аналитики, заявки (Demo MVP)."""
from pydantic import BaseModel, Field

MAX_MESSAGE_LEN = 1000

# Белый список событий продуктовой аналитики. Всё, что не отсюда, — отклоняем.
ALLOWED_EVENTS = {
    # AI-воронка
    "ai_chat_opened",
    "ai_query_submitted",
    "ai_response_received",
    "ai_product_card_viewed",
    "ai_product_card_clicked",
    "ai_order_started_from_ai",
    # Демо-воронка магазина
    "app_opened",
    "catalog_opened",
    "product_viewed",
    "lead_created",
    "admin_opened",
}


class AiChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_LEN)


class EventIn(BaseModel):
    event: str = Field(min_length=1, max_length=64)
    payload: dict = Field(default_factory=dict)


class LeadIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=64)
    product_id: int | None = None
    product_title: str | None = Field(default=None, max_length=300)
    message: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="other", max_length=32)
    delivery_method: str | None = Field(default=None, max_length=32)  # pickup | delivery


class LeadStatusIn(BaseModel):
    status: str | None = Field(default=None, max_length=32)
    assigned_to: str | None = Field(default=None, max_length=200)
    manager_comment: str | None = Field(default=None, max_length=2000)
