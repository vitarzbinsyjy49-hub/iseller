from app.core.cache import cache_key

def test_same_question_same_key():
    a = cache_key("Подбери ноутбук ДО 150 тысяч!", "recommend", {"price_max": 150000})
    b = cache_key("подбери ноутбук до 150 тысяч", "recommend", {"price_max": 150000})
    assert a == b

def test_different_filters_different_key():
    a = cache_key("ноутбук", "search", {"price_max": 100000})
    b = cache_key("ноутбук", "search", {"price_max": 150000})
    assert a != b
