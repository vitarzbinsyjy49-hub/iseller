"""Контракты ответа. Frontend Mini App рисует карточки напрямую из этого JSON."""
from typing import Literal, Optional

from pydantic import BaseModel, Field


class CardButton(BaseModel):
    label: str
    action: Literal["open_product", "add_to_cart", "compare", "ask_more"]
    payload: dict = Field(default_factory=dict)


class ProductCard(BaseModel):
    id: int
    title: str
    price: float
    old_price: Optional[float] = None
    image: Optional[str] = None
    brand: Optional[str] = None
    in_stock: bool = True
    reason: Optional[str] = None            # почему рекомендован (объяснимость)
    buttons: list[CardButton] = Field(default_factory=list)


class ChatRequest(BaseModel):
    user_id: str
    message: str
    session_id: Optional[str] = None


class ChatResponse(BaseModel):
    text: str                                # всегда текст + карточки + кнопки
    cards: list[ProductCard] = Field(default_factory=list)
    actions: list[CardButton] = Field(default_factory=list)
    intent: str = "other"
    cache_hit: bool = False
    trace_id: Optional[str] = None           # воспроизводимость ответов


class FeedbackRequest(BaseModel):
    trace_id: str
    user_id: str
    score: int = Field(ge=-1, le=1)
