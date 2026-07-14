"""Response Builder: текст + карточки + кнопки. Карточки — из БД, не из вывода модели
(модель физически не может выдумать цену или наличие)."""


def product_card(p: dict) -> dict:
    buttons = [{"type": "open_product", "label": "Подробнее", "product_id": p["id"]},
               {"type": "add_to_cart", "label": "В корзину", "product_id": p["id"]}]
    if not p.get("in_stock"):
        buttons = [{"type": "notify_stock", "label": "Сообщить о поступлении",
                    "product_id": p["id"]}]
    return {"id": p["id"], "title": p["title"], "brand": p.get("brand"),
            "price": p["price"], "old_price": p.get("old_price"),
            "in_stock": bool(p.get("in_stock")), "rating": p.get("rating"),
            "image": p.get("image") or "", "url": p.get("url") or "",
            "why": p.get("_why", []), "buttons": buttons}


def build(text: str, products: list[dict], intent: str, meta: dict) -> dict:
    actions = [{"type": "refine", "label": "Уточнить запрос"}]
    if intent in ("search", "recommend") and len(products) >= 2:
        actions.insert(0, {"type": "compare", "label": "Сравнить",
                           "product_ids": [p["id"] for p in products[:3]]})
    return {"text": text.strip(), "cards": [product_card(p) for p in products],
            "actions": actions, "meta": meta}
