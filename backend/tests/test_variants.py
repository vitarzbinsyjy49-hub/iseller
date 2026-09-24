"""Варианты одной модели: память, цвет, SIM — одна карточка вместо сорока."""
from app.services.variants import collapse, family_of, variants_payload
from tests.conftest import make_product


def _p(db, title, price, **kw):
    kw.setdefault("sku", title)
    kw.setdefault("source", "bsa")
    return make_product(db, title=title, price=price, **kw)


def test_stored_family_wins_over_rules(db):
    """Ручная правка в админке главнее правил: товар с сохранённым семейством
    склеивается по нему, даже если правила сказали бы иначе."""
    p = _p(db, "Apple iPhone 18 Pro 256 ГБ Black (KR-HK, SIM+eSIM)", 1,
           family_key="Своя модель", variant={"Цвет": "Чёрный"})
    assert family_of(p) == "Своя модель"


def test_mac_family_from_rules(db):
    a = _p(db, "Apple iMac M4 (10/10/16/256) Purple (SG)", 150000)
    b = _p(db, "Apple iMac M4 (10/10/16/512) Silver (RU)", 170000)
    out, info = collapse([a, b])
    assert [p.id for p in out] == [a.id]
    assert info[a.id]["model"] == "Apple iMac M4" and info[a.id]["colors"] == ["Purple", "Silver"]


def test_collapse_keeps_one_card_per_model_at_first_position(db):
    a = _p(db, "Apple iPhone 18 Pro 512 ГБ Black (KR-HK, SIM+eSIM)", 153000)
    other = _p(db, "PlayStation 5 Pro 2 TB", 70000)
    cheap = _p(db, "Apple iPhone 18 Pro 256 ГБ Silver (US-KW, eSIM)", 127500)
    gone = _p(db, "Apple iPhone 18 Pro 256 ГБ Black (KW, eSIM)", 100000, in_stock=False)
    mx = _p(db, "Apple iPhone 18 Pro Max 256 ГБ Silver (KR-HK, SIM+eSIM)", 148500)

    out, info = collapse([a, other, cheap, gone, mx])

    # Место семейства — там, где встретился первый его вариант; представитель —
    # самый дешёвый В НАЛИЧИИ (дешёвый, но отсутствующий не выигрывает).
    assert [p.id for p in out] == [cheap.id, other.id, mx.id]
    assert info[cheap.id] == {"model": "Apple iPhone 18 Pro", "count": 3, "min_price": 127500.0,
                              "colors": ["Black", "Silver"]}
    assert other.id not in info           # одиночка без семейства


def test_variants_payload_lists_family_members(db):
    cur = _p(db, "Apple iPhone 18 Pro 256 ГБ Black (KR-HK, SIM+eSIM)", 129000)
    _p(db, "Apple iPhone 18 Pro 256 ГБ Black (US-KW, eSIM)", 127500)
    _p(db, "Apple iPhone 18 Pro 512 ГБ Glacier (HK, SIM+eSIM)", 152500)
    _p(db, "Apple iPhone 18 Pro 1 ТБ Black (HK, SIM+eSIM)", 229000, is_active=False)
    _p(db, "Apple iPhone 18 Pro Max 256 ГБ Black (KR-HK, SIM+eSIM)", 156000)

    v = variants_payload(db, cur)

    assert v["axes"] == [
        {"name": "Цвет", "values": ["Black", "Glacier"]},
        {"name": "Память", "values": ["256 ГБ", "512 ГБ"]},
        {"name": "SIM", "values": ["SIM+eSIM", "eSIM"]},
    ]
    assert v["current"] == {"values": {"Цвет": "Black", "Память": "256 ГБ", "SIM": "SIM+eSIM"},
                            "regions": ["KR", "HK"]}
    assert len(v["options"]) == 3        # выключенный и Pro Max не входят
    assert {o["price"] for o in v["options"]} == {129000.0, 127500.0, 152500.0}


def test_single_member_family_has_no_picker(db):
    only = _p(db, "Apple iPhone 18 Pro 256 ГБ Black (KR-HK, SIM+eSIM)", 129000)
    assert variants_payload(db, only) is None
    assert family_of(only) == "Apple iPhone 18 Pro"


# ---------------------------------------------------------------- API

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User


@pytest.fixture()
def client(db):
    user = User(telegram_id=1)
    db.add(user)
    db.commit()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    yield TestClient(app)
    app.dependency_overrides.clear()


def _family(db):
    a = _p(db, "Apple iPhone 18 Pro 256 ГБ Black (KR-HK, SIM+eSIM)", 129000)
    b = _p(db, "Apple iPhone 18 Pro 256 ГБ Silver (US-KW, eSIM)", 127500)
    c = _p(db, "Apple iPhone 18 Pro 512 ГБ Black (HK, SIM+eSIM)", 153000)
    return a, b, c


def test_detail_carries_variants(db, client):
    a, _, _ = _family(db)
    body = client.get(f"/api/catalog/product/{a.id}").json()
    assert body["variants"]["current"]["values"]["Цвет"] == "Black"
    assert len(body["variants"]["options"]) == 3


def test_list_shows_one_card_per_model(db, client):
    _, b, _ = _family(db)
    _p(db, "PlayStation 5 Pro 2 TB", 70000, category="консоли")
    cards = client.get("/api/catalog/list?query=iphone").json()["cards"]
    assert [c["id"] for c in cards] == [b.id]
    assert cards[0]["family"]["count"] == 3
    assert cards[0]["family"]["min_price"] == 127500.0


def test_search_collapses_too(db, client):
    _, b, _ = _family(db)
    cards = client.get("/api/catalog/search?query=iphone 18").json()["cards"]
    assert [c["id"] for c in cards] == [b.id]


def test_feed_new_section_has_one_card_per_model(db, client):
    for p in _family(db):
        p.is_new = True
    db.commit()
    new = client.get("/api/catalog/feed").json()["new"]
    ids = [c["id"] for c in new]
    assert len([c for c in new if "iPhone 18 Pro" in c["title"]]) == 1, ids


def test_feed_section_is_not_eaten_by_one_big_family(db, client):
    """40 вариантов одной модели не должны занять всю выборку секции: иначе в
    «Горячем» остаются две карточки, а представитель — не самый дешёвый."""
    for i in range(40):
        _p(db, f"Apple iPhone 18 Pro {256 if i % 2 else 512} ГБ Black ({'HK' if i < 20 else 'KW'}, SIM+eSIM)",
           200000 - i, is_hot=True, sku=f"V{i}")
    _p(db, "Apple iPhone 18 Pro 256 ГБ Black (US, eSIM)", 100000, is_hot=True, sku="CHEAP")
    for i in range(5):
        _p(db, f"PlayStation {i}", 50000, is_hot=True, sku=f"PS{i}")
    hot = client.get("/api/catalog/feed").json()["hot"]
    assert len(hot) >= 6
    assert any(c["sku"] == "CHEAP" for c in hot)


def test_family_summary_counts_the_whole_family_not_the_section(db, client):
    """В «Горячем» может быть лишь часть вариантов модели, но «от X ₽» и число
    вариантов на карточке — про модель целиком: иначе цена «от» завышена."""
    _p(db, "Apple iPhone 18 Pro 256 ГБ Black (KR-HK, SIM+eSIM)", 129000, is_hot=True)
    _p(db, "Apple iPhone 18 Pro 512 ГБ Black (HK, SIM+eSIM)", 153000, is_hot=True)
    _p(db, "Apple iPhone 18 Pro 256 ГБ Silver (US-KW, eSIM)", 127500)       # не «горячий»
    [card] = [c for c in client.get("/api/catalog/feed").json()["hot"] if "18 Pro" in c["title"]]
    assert card["family"]["count"] == 3
    assert card["family"]["min_price"] == 127500.0
