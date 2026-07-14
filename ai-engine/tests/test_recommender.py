from app.core.recommender import rank

PRODUCTS = [
    {"id": 1, "title": "MacBook Pro", "brand": "Apple", "category": "ноутбуки",
     "price": 149000, "in_stock": True, "rating": 4.9, "popularity": 90,
     "margin_pct": 10, "_relevance": 0.9},
    {"id": 2, "title": "Xiaomi Book", "brand": "Xiaomi", "category": "ноутбуки",
     "price": 80000, "in_stock": True, "rating": 4.3, "popularity": 70,
     "margin_pct": 25, "_relevance": 0.95},
    {"id": 3, "title": "Old Model", "brand": "Acer", "category": "ноутбуки",
     "price": 60000, "in_stock": False, "rating": 3.9, "popularity": 10,
     "margin_pct": 5, "_relevance": 0.99},
]

def test_personalization_apple_first():
    """Если пользователь любит Apple — Xiaomi не первым."""
    top = rank(PRODUCTS, {"favorite_brands": ["Apple"]}, 3)
    assert top[0]["brand"] == "Apple"

def test_out_of_stock_penalized():
    top = rank(PRODUCTS, None, 3)
    assert top[-1]["id"] == 3  # нет в наличии — вниз, несмотря на релевантность

def test_why_explanations():
    top = rank(PRODUCTS, {"favorite_brands": ["Apple"]}, 1)
    assert any("Apple" in w for w in top[0]["_why"])
