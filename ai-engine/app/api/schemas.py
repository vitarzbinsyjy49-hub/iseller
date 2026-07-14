from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    message: str = Field(min_length=1, max_length=2000)


class RecommendRequest(BaseModel):
    user_id: str
    category: str | None = None
    budget_max: int | None = Field(default=None, ge=0)
    use_case: str | None = None


class CompareRequest(BaseModel):
    user_id: str
    product_ids: list[int] = Field(min_length=2, max_length=5)


class SearchRequest(BaseModel):
    user_id: str = "anonymous"
    query: str = Field(min_length=1, max_length=500)
    filters: dict = Field(default_factory=dict)


class FeedbackRequest(BaseModel):
    user_id: str
    analytics_id: int | None = None
    rating: int = Field(ge=1, le=5)
    comment: str = Field(default="", max_length=1000)


class PurchaseEvent(BaseModel):
    user_id: str
    analytics_id: int | None = None
    product_ids: list[int] = []
