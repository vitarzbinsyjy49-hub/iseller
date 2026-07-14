import pytest
from app.core.intent import _rule_based, analyze
from app.llm.base import LLMProvider, LLMResult


class FakeLLM(LLMProvider):
    def __init__(self, text='{"intent":"recommend","filters":{"category":"ноутбук","price_max":150000},"query":"ноутбук для монтажа"}'):
        self.text = text
    async def complete(self, system, user, *, json_mode=False, max_tokens=800):
        return LLMResult(text=self.text, model="fake")


def test_rules_price():
    r = _rule_based("подбери ноутбук до 150 тысяч для монтажа")
    assert r.intent == "recommend"
    assert r.filters["price_max"] == 150000

def test_rules_faq():
    assert _rule_based("какая гарантия на телефоны?").intent == "warranty"
    assert _rule_based("есть ли доставка завтра?").intent == "delivery"

@pytest.mark.asyncio
async def test_llm_intent():
    it = await analyze("что взять для видеомонтажа?", FakeLLM())
    assert it.intent == "recommend"
    assert it.filters.get("category") == "ноутбук"

@pytest.mark.asyncio
async def test_llm_broken_json_degrades():
    it = await analyze("случайный вопрос", FakeLLM(text="не json"))
    assert it.intent in {"search", "other"}  # пайплайн не падает
