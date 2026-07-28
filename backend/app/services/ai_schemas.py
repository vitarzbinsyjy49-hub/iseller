"""Structured output локального AI-консультанта (v5).

Схема ответа LLM + безопасный парсер. Модель обязана вернуть строго JSON;
если JSON повреждён — одна попытка repair (срезаем код-фенсы, вытаскиваем
первый сбалансированный объект), дальше — исключение и fallback уровнем выше.
Пользователь НИКОГДА не видит сырой JSON или traceback.
"""
import json
import re

from pydantic import BaseModel, Field, ValidationError, field_validator

INTENTS = {
    "product_search", "comparison", "product_question", "general_help",
    "wholesale", "b2b", "trade_in", "manager", "unsupported",
}
NEXT_ACTIONS = {"ask_question", "show_products", "create_lead", "open_manager", "none"}

# Быстрые ответы: больше четырёх чипов не помещаются в ряд, длинный текст
# превращает кнопку в абзац. Режем здесь, а не в вёрстке.
QUICK_REPLY_LIMIT = 4
QUICK_REPLY_MAX_LEN = 40


class AiComparisonItem(BaseModel):
    product_id: int
    best_for: str = ""
    strengths: list[str] = Field(default_factory=list)
    tradeoffs: list[str] = Field(default_factory=list)

    @field_validator("product_id", mode="before")
    @classmethod
    def _coerce_id(cls, v):  # модель может вернуть id строкой
        return int(str(v).strip())


class AiFilters(BaseModel):
    category: str | None = None
    brands: list[str] = Field(default_factory=list)
    budget_min: float | None = None
    budget_max: float | None = None
    use_cases: list[str] = Field(default_factory=list)
    required_features: list[str] = Field(default_factory=list)
    excluded_features: list[str] = Field(default_factory=list)


class AiStructuredAnswer(BaseModel):
    """Контракт structured output (см. постановку задачи)."""
    intent: str = "product_search"
    answer: str = Field(min_length=1, max_length=4000)
    follow_up_question: str | None = Field(default=None, max_length=500)
    recommended_product_ids: list[int] = Field(default_factory=list)
    comparison: list[AiComparisonItem] = Field(default_factory=list)
    filters: AiFilters = Field(default_factory=AiFilters)
    # Быстрые ответы (v5.9): готовые реплики покупателя на follow_up_question.
    # Нужны, чтобы диалог продолжался нажатием, а не печатью — раньше на месте
    # этой кнопки была «Уточнить запрос», которая только фокусировала поле.
    quick_replies: list[str] = Field(default_factory=list)
    next_action: str = "none"
    confidence: float = 0.0

    @field_validator("intent", mode="before")
    @classmethod
    def _intent_known(cls, v):
        v = str(v or "").strip().lower()
        return v if v in INTENTS else "unsupported"

    @field_validator("next_action", mode="before")
    @classmethod
    def _action_known(cls, v):
        v = str(v or "").strip().lower()
        return v if v in NEXT_ACTIONS else "none"

    @field_validator("recommended_product_ids", mode="before")
    @classmethod
    def _coerce_ids(cls, v):
        if not isinstance(v, list):
            return []
        out: list[int] = []
        for item in v[:10]:
            try:
                out.append(int(str(item).strip()))
            except (TypeError, ValueError):
                continue
        return out

    @field_validator("quick_replies", mode="before")
    @classmethod
    def _clean_quick_replies(cls, v):
        """Короткие, непустые, без дублей, не больше четырёх.

        Длинные варианты не помещаются в чип и превращают ряд кнопок в стену
        текста, поэтому режем по длине, а не переносим."""
        if not isinstance(v, list):
            return []
        out: list[str] = []
        seen: set[str] = set()
        for item in v:
            text = " ".join(str(item or "").split())[:QUICK_REPLY_MAX_LEN].strip()
            key = text.lower()
            if text and key not in seen:
                seen.add(key)
                out.append(text)
            if len(out) >= QUICK_REPLY_LIMIT:
                break
        return out

    @field_validator("confidence", mode="before")
    @classmethod
    def _clamp_confidence(cls, v):
        try:
            return max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            return 0.0


class AiAnswerParseError(Exception):
    """LLM вернула невалидный/невосстановимый JSON."""


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def _extract_first_object(text: str) -> str | None:
    """Первый сбалансированный {...} с учётом строк — дешёвый repair без зависимостей."""
    start = text.find("{")
    if start == -1:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def parse_structured_answer(raw: str) -> AiStructuredAnswer:
    """Строгий парс -> одна попытка repair -> AiAnswerParseError."""
    if not raw or not raw.strip():
        raise AiAnswerParseError("empty LLM output")

    candidates = [raw.strip()]
    cleaned = _FENCE_RE.sub("", raw).strip()
    if cleaned != candidates[0]:
        candidates.append(cleaned)
    extracted = _extract_first_object(cleaned)
    if extracted and extracted not in candidates:
        candidates.append(extracted)

    last_error: Exception | None = None
    for candidate in candidates:
        try:
            data = json.loads(candidate)
            if not isinstance(data, dict):
                raise ValueError("top-level JSON is not an object")
            return AiStructuredAnswer.model_validate(data)
        except (ValueError, ValidationError) as e:
            last_error = e
    raise AiAnswerParseError(f"unparseable LLM output: {last_error}") from last_error
