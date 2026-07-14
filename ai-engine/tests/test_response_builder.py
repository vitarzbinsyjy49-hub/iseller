from app.core.response_builder import build, product_card

def test_card_shape():
    c = product_card({"id": 1, "title": "X", "price": 100, "in_stock": True})
    assert set(c) >= {"id", "title", "price", "image", "buttons"}
    assert c["buttons"][0]["type"] == "open_product"

def test_out_of_stock_button():
    c = product_card({"id": 1, "title": "X", "price": 100, "in_stock": False})
    assert c["buttons"][0]["type"] == "notify_stock"

def test_compare_action_added():
    r = build("текст", [{"id": 1, "title": "A", "price": 1, "in_stock": True},
                        {"id": 2, "title": "B", "price": 2, "in_stock": True}], "search", {})
    assert any(a["type"] == "compare" for a in r["actions"])
