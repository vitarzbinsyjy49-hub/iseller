"""Recommendation Engine: коммерческие решения принимает бизнес-логика, НЕ модель.
Учитывает: наличие, маржу, популярность, рейтинг, новинки/акции, персонализацию."""
from ..config import get_business_config


def rank(products: list[dict], profile: dict | None, top_n: int) -> list[dict]:
    cfg = get_business_config()["ranking"]
    w = cfg["weights"]
    fav_brands = set((profile or {}).get("favorite_brands", []))
    fav_cats = set((profile or {}).get("favorite_categories", []))

    if cfg["hard_filters"]["hide_out_of_stock"]:
        products = [p for p in products if p.get("in_stock")]

    max_pop = max((p.get("popularity") or 0 for p in products), default=1) or 1
    scored = []
    for p in products:
        pers = (0.6 if p.get("brand") in fav_brands else 0) + \
               (0.4 if p.get("category") in fav_cats else 0)
        score = (
            w["relevance"] * p.get("_relevance", 0)
            + w["in_stock"] * (1.0 if p.get("in_stock") else 0.0)
            + w["personalization"] * pers
            + w["rating"] * ((p.get("rating") or 0) / 5)
            + w["popularity"] * ((p.get("popularity") or 0) / max_pop)
            + w["margin"] * min((p.get("margin_pct") or 0) / 30, 1.0)
            + w["promo_new"] * (0.5 * bool(p.get("on_sale")) + 0.5 * bool(p.get("is_new")))
        )
        p["_score"] = round(score, 4)
        p["_why"] = _why(p, fav_brands)
        scored.append(p)
    return sorted(scored, key=lambda x: -x["_score"])[:top_n]


def _why(p: dict, fav_brands: set) -> list[str]:
    why = []
    if p.get("in_stock"): why.append("в наличии")
    if p.get("brand") in fav_brands: why.append(f"вы предпочитаете {p['brand']}")
    if p.get("on_sale"): why.append("сейчас по акции")
    if (p.get("rating") or 0) >= 4.5: why.append(f"рейтинг {p['rating']}")
    if p.get("is_new"): why.append("новинка")
    return why
