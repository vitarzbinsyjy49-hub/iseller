"""Intent Analyzer: сначала дешёвые правила (0 токенов), LLM — только если правила не сработали."""
import json
import re
from dataclasses import dataclass, field

from app.config import get_yaml_config
from app.llm.factory import get_llm
from app.prompts.builder import build

INTENTS = {"product_search", "comparison", "recommendation", "advice", "trade_in",
           "warranty", "payment", "delivery", "accessory_compatibility", "news", "other"}

_RULES = [
    (r"(сравн|что лучше| или )", "comparison"),
    (r"(trade.?in|трейд.?ин|обмен)", "trade_in"),
    (r"(гаранти)", "warranty"),
    (r"(оплат|рассрочк|кредит)", "payment"),
    (r"(доставк|самовывоз)", "delivery"),
    (r"(подойд[её]т|совместим|чехол|зарядк)", "accessory_compatibility"),
    (r"(новинк|вышел|анонс)", "news"),
    (r"(подбер|посоветуй|порекоменд|нужен|ищу|хочу купить|до \d)", "recommendation"),
]

_PRICE_RE = re.compile(r"до\s*(\d[\d\s]*)\s*(тыс|т\.|k|к\b)?", re.I)


@dataclass
class Intent:
    name: str = "other"
    confidence: float = 0.0
    filters: dict = field(default_factory=dict)


def _extract_price_max(text: str) -> float | None:
    m = _PRICE_RE.search(text.lower())
    if not m:
        return None
    value = float(m.group(1).replace(" ", ""))
    if m.group(2):                      # «до 150 тысяч»
        value *= 1000
    return value


def rule_based(text: str) -> Intent:
    low = text.lower()
    for pattern, intent in _RULES:
        if re.search(pattern, low):
            filters = {"query": text}
            price = _extract_price_max(text)
            if price:
                filters["price_max"] = price
            return Intent(intent, 0.75, filters)
    return Intent("other", 0.0, {"query": text})


async def analyze(text: str) -> Intent:
    intent = rule_based(text)
    threshold = get_yaml_config()["intents"]["confidence_threshold"]
    if intent.confidence >= threshold:
        return intent
    # fallback: одна короткая LLM-классификация
    try:
        raw = (await get_llm().complete(
            build("intent_classifier.yaml", "classify", question=text),
            temperature=0.0, max_tokens=200)).text
        data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
        name = data.get("intent", "other")
        return Intent(name if name in INTENTS else "other",
                      float(data.get("confidence", 0.5)),
                      {k: v for k, v in (data.get("filters") or {}).items() if v})
    except Exception:
        return intent
