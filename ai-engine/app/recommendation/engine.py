"""Recommendation Engine: коммерческие решения принимает бизнес-логика, а не модель.
Учитывает наличие, маржу, популярность, рейтинг, акции и профиль пользователя.
Каждой рекомендации присваивается объяснение (reason)."""
from app.config import get_yaml_config


def _norm(v, default=0.0) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return default


def score_products(products: list[dict], memory: dict | None = None,
                   filters: dict | None = None) -> list[dict]:
    cfg = get_yaml_config()["ranking"]
    w, pers = cfg["weights"], cfg["personalization"]
    memory, filters = memory or {}, filters or {}
    preferred_brands = {str(b).lower() for b in (memory.get("preferred_brands") or [])}
    budget_max = filters.get("price_max") or memory.get("budget_max")

    ranked = []
    for src in products:
        p = dict(src)
        reasons = []
        score = (
            w["relevance"] * 1.0
            + w["in_stock"] * (1.0 if p.get("in_stock") else 0.0)
            + w["margin"] * _norm(p.get("margin"))
            + w["popularity"] * _norm(p.get("popularity"))
            + w["rating"] * _norm((p.get("rating") or 0) / 5)
            + w["is_promo"] * (1.0 if p.get("is_promo") else 0.0)
        )
        if p.get("in_stock"):
            reasons.append("в наличии")
        if p.get("is_promo"):
            reasons.append("по акции")
        if (p.get("rating") or 0) >= 4.5:
            reasons.append(f"рейтинг {p['rating']}")
        # персонализация: любимый бренд первым; чужой не наказываем, просто не бустим
        if p.get("brand") and p["brand"].lower() in preferred_brands:
            score += pers["preferred_brand_boost"]
            reasons.append("ваш любимый бренд")
        if budget_max and p.get("price") is not None and float(p["price"]) <= float(budget_max):
            score += pers["budget_fit_boost"]
            reasons.append("вписывается в бюджет")

        p["_score"] = round(score, 4)
        p["_reason"] = ", ".join(reasons) or "соответствует запросу"
        ranked.append(p)

    return sorted(ranked, key=lambda x: x["_score"], reverse=True)
