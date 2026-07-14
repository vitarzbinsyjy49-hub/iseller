"""Оркестратор AI Pipeline:
вопрос -> интент -> кэш -> поиск -> Recommendation Engine -> Prompt Builder -> LLM
-> Response Builder -> ответ. LLM — последний и самый дорогой шаг; всё, что можно,
решается до него (правила, кэш, поиск, FAQ).

FIX (integration): согласованы фактические интерфейсы модулей:
- intent.analyze(text) принимает один аргумент и возвращает Intent(name, confidence, filters);
- имена интентов из intent.py (product_search/comparison/...) приводятся к каноническим
  коротким (search/compare/...), которые ожидают prompt_builder и response_builder;
- LLMProvider.complete(prompt) принимает ОДИН промпт — system и user склеиваются;
- LLMResult хранит tokens_in/tokens_out (а не prompt_tokens/completion_tokens).
"""
import time

from ..llm.base import LLMProvider, LLMResult
from ..config import get_settings, get_business_config
from . import intent as intent_mod, recommender, prompt_builder, response_builder
from .retriever import Retriever
from .memory import Memory
from .cache import Cache, cache_key
from ..analytics.logger import Analytics

# intent.py -> канонические имена для downstream-модулей
_CANON = {
    "product_search": "search",
    "comparison": "compare",
    "recommendation": "recommend",
    "accessory_compatibility": "compatibility",
}
PRODUCT_INTENTS = {"search", "compare", "recommend", "compatibility", "advice"}
FAQ_INTENTS = {"warranty", "payment", "delivery", "trade_in"}


class Pipeline:
    def __init__(self, llm: LLMProvider, retriever: Retriever, memory: Memory,
                 cache: Cache, analytics: Analytics):
        self.llm, self.retriever = llm, retriever
        self.memory, self.cache, self.analytics = memory, cache, analytics

    async def run(self, user_id: str, question: str) -> dict:
        t0 = time.monotonic()
        s = get_settings()
        error = None
        llm_res = LLMResult(text="", model=s.llm_model)
        cache_hit = False
        products: list[dict] = []

        it = await intent_mod.analyze(question)
        intent_name = _CANON.get(it.name, it.name)
        filters = dict(it.filters)
        query = filters.pop("query", None) or question

        key = cache_key(question, intent_name, filters)
        if cached := await self.cache.get(key):
            cache_hit = True
            answer = cached
        else:
            profile = await self.memory.get_profile(user_id)
            if intent_name in FAQ_INTENTS:
                # FAQ — без LLM вообще: мгновенно и бесплатно
                faq = get_business_config().get("faq", {})
                answer = response_builder.build(
                    faq.get(intent_name, "Уточните, пожалуйста, вопрос — передам менеджеру."),
                    [], intent_name, {})
            else:
                if intent_name in PRODUCT_INTENTS:
                    found = await self.retriever.search(query, filters, limit=30)
                    products = recommender.rank(found, profile, s.max_products_to_llm)
                try:
                    system, user = prompt_builder.build_answer_prompt(
                        question, intent_name, profile, products)
                    llm_res = await self.llm.complete(f"{system}\n\n{user}",
                                                      max_tokens=s.llm_max_tokens)
                    text = llm_res.text
                except Exception as e:  # деградация: карточки без текста лучше, чем ничего
                    error = str(e)[:500]
                    text = ("Вот что нашлось в каталоге:" if products
                            else "Сервис временно перегружен, попробуйте ещё раз.")
                answer = response_builder.build(text, products, intent_name, {})
            await self.cache.set(key, answer)

        latency = int((time.monotonic() - t0) * 1000)
        analytics_id = await self.analytics.log(
            user_id=user_id, question=question, answer=answer["text"], intent=intent_name,
            model=llm_res.model, latency_ms=latency, prompt_tokens=llm_res.tokens_in,
            completion_tokens=llm_res.tokens_out, cost_usd=llm_res.cost_usd,
            cache_hit=cache_hit, error=error)
        await self.memory.remember_interaction(
            user_id, question, answer["text"], intent_name,
            [c["id"] for c in answer.get("cards", [])])

        answer["meta"] = {"intent": intent_name, "latency_ms": latency,
                          "cache_hit": cache_hit, "analytics_id": analytics_id,
                          "model": llm_res.model if not cache_hit else "cache"}
        return answer
