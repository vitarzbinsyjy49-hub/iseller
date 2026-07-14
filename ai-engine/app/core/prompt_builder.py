"""Prompt Builder: собирает контекст ТОЛЬКО из проверенных данных (каталог, FAQ, профиль).
Полный каталог в модель не отправляется никогда."""
import json
from ..config import get_prompts, get_business_config


def build_context(products: list[dict], intent: str) -> str:
    lines = []
    for p in products:
        lines.append(json.dumps({
            "id": p["id"], "title": p["title"], "brand": p.get("brand"),
            "price": p["price"], "old_price": p.get("old_price"),
            "in_stock": p.get("in_stock"), "rating": p.get("rating"),
            "specs": p.get("specs") or {}, "why": p.get("_why", []),
        }, ensure_ascii=False))
    faq = get_business_config()["faq"]
    if intent in faq:
        lines.append(f'FAQ[{intent}]: {faq[intent]}')
    return "\n".join(lines) if lines else "(данных нет)"


def build_answer_prompt(question: str, intent: str, profile: dict | None,
                        products: list[dict]) -> tuple[str, str]:
    p = get_prompts()
    system = p["compare_system"] + "\n" + p["answer_system"] if intent == "compare" \
        else p["answer_system"]
    user = p["answer_user_template"].format(
        question=question, intent=intent,
        profile=json.dumps(profile or {}, ensure_ascii=False),
        context=build_context(products, intent))
    return system, user
