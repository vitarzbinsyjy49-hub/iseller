"""Правила склейки вариантов по линейкам — на реальных названиях каталога."""
import pytest

from app.services.family_rules import resolve


class P:
    """Минимальный товар: правилам нужны только название, цвет и подкатегория."""

    def __init__(self, title, color=None, subcategory=None):
        self.title, self.color, self.subcategory = title, color, subcategory


@pytest.mark.parametrize("title,color,sub,family,variant", [
    ("Apple iPhone 18 Pro Max 256 ГБ Glacier (KR-HK, SIM+eSIM)", None, "iPhone",
     "Apple iPhone 18 Pro Max", {"Цвет": "Glacier", "Память": "256 ГБ", "SIM": "SIM+eSIM"}),
    ("Apple iPad Pro 11 M5 256 Black LTE (US)", "Black", "iPad Pro",
     "Apple iPad Pro 11 M5", {"Цвет": "Black", "Память": "256 ГБ", "Связь": "LTE"}),
    ('Apple iPad Air 8 13" M4 1TB Wi-Fi Space Gray', "Space Gray", "iPad Air",
     'Apple iPad Air 8 13" M4', {"Цвет": "Space Gray", "Память": "1 ТБ", "Связь": "Wi-Fi"}),
    ("Apple MacBook Air 13 (M5 16/1Tb) Midnight (US-HK)", "Midnight", "MacBook Air",
     "Apple MacBook Air 13 M5", {"Цвет": "Midnight", "Конфигурация": "16 ГБ · 1 ТБ"}),
    ("Apple MacBook Air 15 Starlight (M5, 16GB, 512GB) (US)", "Starlight", "MacBook Air",
     "Apple MacBook Air 15 M5", {"Цвет": "Starlight", "Конфигурация": "16 ГБ · 512 ГБ"}),
    ("Apple MacBook Pro 14 M5 Pro 15/16 24GB 1TB Silver (US)", "Silver", "MacBook Pro",
     "Apple MacBook Pro 14 M5 Pro", {"Цвет": "Silver", "Конфигурация": "15/16 · 24 ГБ · 1 ТБ"}),
    ("Apple MacBook Pro 16 M5 Pro 18C/20C/48Gb/1Tb Black (US-IN)", "Black", "MacBook Pro",
     "Apple MacBook Pro 16 M5 Pro", {"Цвет": "Space Black", "Конфигурация": "18/20 · 48 ГБ · 1 ТБ"}),
    ("Apple iMac M4 (10/10/16/256) Purple (SG)", None, "iMac",
     "Apple iMac M4", {"Цвет": "Purple", "Конфигурация": "10/10 · 16 ГБ · 256 ГБ"}),
    ("Apple iMac M3 (8/10/256) Blue (SG)", None, "iMac",
     "Apple iMac M3", {"Цвет": "Blue", "Конфигурация": "8/10 · 256 ГБ"}),
    ("Apple MacBook Air 13 Sky Blue (M4 16/10/10/512GB) (US-IN)", "Sky Blue", "MacBook Air",
     "Apple MacBook Air 13 M4", {"Цвет": "Sky Blue", "Конфигурация": "10/10 · 16 ГБ · 512 ГБ"}),
    ("Apple MacBook Pro 14 M5 16/512 (2025) Black (US-IN)", "Black", "MacBook Pro",
     "Apple MacBook Pro 14 M5", {"Цвет": "Space Black", "Конфигурация": "16 ГБ · 512 ГБ"}),
    ("Apple Mac Mini M4 Pro (24/512) (US)", None, "Mac mini",
     "Apple Mac mini M4 Pro", {"Конфигурация": "24 ГБ · 512 ГБ"}),
    ("Apple Mac Studio M3 Ultra 28 60 96GB 1TB", None, "Mac Studio",
     "Apple Mac Studio M3 Ultra", {"Конфигурация": "28/60 · 96 ГБ · 1 ТБ"}),
    ("Apple Mac Studio M4 Max 128 2TB", None, "Mac Studio",
     "Apple Mac Studio M4 Max", {"Конфигурация": "128 ГБ · 2 ТБ"}),
    ("Apple AirPods Max 2026 Orange (US)", None, "AirPods",
     "Apple AirPods Max 2026", {"Цвет": "Orange"}),
    ("Dyson HD16 Red Velvet (Case) (HK)", "Red Velvet", "Фены",
     "Dyson HD16", {"Цвет": "Red Velvet", "Комплектация": "С кейсом"}),
    ("Dyson HD16 Blue Copper (HK)", "Blue Copper", "Фены",
     "Dyson HD16", {"Цвет": "Blue Copper", "Комплектация": "Стандартная"}),
    ("Dyson HT01 Ceramic/Pink Case (KR)", None, "Выпрямители",
     "Dyson HT01", {"Цвет": "Ceramic Pink", "Комплектация": "С кейсом"}),
    ("Sony DualSense PS5 Chrome Pearl", "Chrome Pearl", "Аксессуары PlayStation",
     "Sony DualSense", {"Цвет": "Chrome Pearl"}),
    ("PlayStation 5 Pulse Elite White", "White", "Аксессуары PlayStation",
     "PlayStation 5 Pulse Elite", {"Цвет": "White"}),
])
def test_rules_on_real_titles(title, color, sub, family, variant):
    got = resolve(P(title, color, sub))
    assert got is not None, title
    assert got.family == family
    assert got.variant == variant


@pytest.mark.parametrize("title,color,sub", [
    # Уценка/ремонт — отдельное предложение, в модель не вливается.
    ('Apple iPad Air 6 13" M2 128GB LTE Space Gray (заменён дисплей)', "Space Gray", "iPad Air"),
    # Часы и пылесосы пока не склеиваем: риск слить разные товары выше пользы.
    ("Apple Watch Series 11 46mm Jet Black SB S/M", "Jet Black", "Apple Watch"),
    ("Dyson V15 SV47 Detect Submarine Yellow Nickel (EU)", "Yellow Nickel", "Пылесосы"),
    ("Sony DualSense Edge White", "White", "Аксессуары PlayStation"),
    ("PlayStation 5 Pro 2 TB", None, "Консоли"),
])
def test_not_grouped(title, color, sub):
    assert resolve(P(title, color, sub)) is None


def test_region_is_kept_aside():
    got = resolve(P("Apple iMac M4 (10/10/16/512) Silver (GB)", None, "iMac"))
    assert got.regions == ["GB"]


def test_backfill_fills_only_empty(db):
    from app.models.product import Product
    from app.scripts.backfill_families import backfill
    from tests.conftest import make_product

    make_product(db, title="Apple iMac M4 (10/10/16/256) Purple (SG)", sku="A")
    make_product(db, title="Apple iMac M4 (10/10/16/512) Silver (RU)", sku="B",
                 family_key="Ручная", variant={"Цвет": "Серебро"})
    make_product(db, title="PlayStation 5 Pro 2 TB", sku="C")

    assert backfill(db, dry_run=False) == {"Apple iMac M4": 1}
    rows = {p.sku: (p.family_key, p.variant) for p in db.query(Product)}
    assert rows["A"] == ("Apple iMac M4", {"Цвет": "Purple", "Конфигурация": "10/10 · 16 ГБ · 256 ГБ"})
    assert rows["B"] == ("Ручная", {"Цвет": "Серебро"})
    assert rows["C"] == (None, None)
