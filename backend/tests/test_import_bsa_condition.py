"""ASIS из прайса BSA — это состояние товара, а не только слово в названии.

Пока отметка жила лишь в заголовке («… Orange [ASIS]»), у товара оставалось
condition=new, и фильтр «только новые» в каталоге и ИИ-подборе отдавал
витринные образцы как новые аппараты.
"""
from app.models.product import CONDITION_SHOWCASE, Product
from app.scripts.fix_asis_condition import find_asis, main as fix_main
from app.scripts.import_bsa import catalog_condition, upsert
from app.services.ai_retrieval import extract_filters
from app.services.bsa_parser import MacItem, parse_line, parse_mac_line
from tests.conftest import make_product


def test_asis_rows_map_to_showcase_and_the_rest_to_new():
    asis = parse_line("17 Pro 512 Orange ASIS 🇺🇸 102 000")
    plain = parse_line("17 Pro 512 Orange 🇺🇸 112 000")
    assert asis is not None and asis.asis and plain is not None
    assert catalog_condition(asis) == CONDITION_SHOWCASE
    assert catalog_condition(plain) == "new"

    # В выгрузках Mac ASIS пока не встречался, но парсер его распознаёт.
    mac_asis = MacItem(title="MacBook Air 13 M4", price=80_000, category="ноутбуки",
                       condition="ASIS")
    # Остальные пометки Mac (мятая коробка, после сервиса) — решение владельца
    # 25.09.2026: пока не трогаем, товар остаётся новым.
    mac_box = parse_mac_line("🇷🇺 [MWUU3] iMac M4 (10/10/16/256GB) Silver (мятая 📦) — 170500")
    assert catalog_condition(mac_asis) == CONDITION_SHOWCASE
    assert mac_box is not None and catalog_condition(mac_box) == "new"


def test_import_creates_and_updates_asis_as_showcase(db):
    kw = dict(price=100_000, category="смартфоны", subcategory="iPhone",
              brand="Apple", photo_name=None, dry_run=False)
    upsert(db, sku="IP-17PRO-512-ORANGE-US-SIM-ASIS",
           title="Apple iPhone 17 Pro 512 ГБ Orange [ASIS] (US)",
           condition=CONDITION_SHOWCASE, **kw)
    db.commit()
    row = db.query(Product).filter_by(sku="IP-17PRO-512-ORANGE-US-SIM-ASIS").one()
    assert row.condition == CONDITION_SHOWCASE

    # Карточка, заведённая до исправления, чинится первым же полным импортом.
    make_product(db, sku="IP-17-256-BLACK-US-SIM-ASIS", source="bsa", condition="new",
                 title="Apple iPhone 17 256 ГБ Black [ASIS] (US)")
    result = upsert(db, sku="IP-17-256-BLACK-US-SIM-ASIS",
                    title="Apple iPhone 17 256 ГБ Black [ASIS] (US)",
                    condition=CONDITION_SHOWCASE, **kw)
    db.commit()
    assert result == "обновлён"
    assert db.query(Product).filter_by(sku="IP-17-256-BLACK-US-SIM-ASIS").one().condition \
        == CONDITION_SHOWCASE


def test_prices_only_does_not_touch_condition(db):
    make_product(db, sku="IP-17-256-BLACK-US-SIM-ASIS", source="bsa", condition="new",
                 price=90_000)
    upsert(db, sku="IP-17-256-BLACK-US-SIM-ASIS", title="x", price=100_000,
           category="смартфоны", subcategory="iPhone", brand="Apple", photo_name=None,
           dry_run=False, prices_only=True, condition=CONDITION_SHOWCASE)
    db.commit()
    assert db.query(Product).one().condition == "new"


def test_data_fix_finds_only_asis_marked_as_new(db):
    make_product(db, sku="IP-17PRO-512-ORANGE-US-SIM-ASIS",
                 title="Apple iPhone 17 Pro 512 ГБ Orange [ASIS] (US)")
    make_product(db, sku="IP-17-256-BLUE-JP-ESIM-ASIS-ACT",
                 title="Apple iPhone 17 256 ГБ Blue [ASIS, актив] (JP, eSIM)")
    make_product(db, sku="MW0Y3-US-ASIS", title="Apple MacBook Air 13 M4 ASIS (US)")
    make_product(db, sku="IP-17-256-BLACK-US-SIM", title="Apple iPhone 17 256 ГБ Black (US)")
    # «Basis» и прочие слова с asis внутри — не пометка.
    make_product(db, sku="CASE-BASIS", title="Чехол Basis для iPhone 17")
    make_product(db, sku="IP-17-256-PINK-US-SIM-ASIS", condition="used",
                 title="Apple iPhone 17 256 ГБ Pink [ASIS] (US)")

    found = sorted(p.sku for p in find_asis(db))
    assert found == ["IP-17-256-BLUE-JP-ESIM-ASIS-ACT", "IP-17PRO-512-ORANGE-US-SIM-ASIS",
                     "MW0Y3-US-ASIS"]


def test_data_fix_is_dry_run_without_confirm(db, monkeypatch):
    import app.scripts.fix_asis_condition as fix

    make_product(db, sku="IP-17-256-BLACK-US-SIM-ASIS",
                 title="Apple iPhone 17 256 ГБ Black [ASIS] (US)")
    monkeypatch.setattr(fix, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)

    assert fix_main([]) == 0
    db.expire_all()
    assert db.query(Product).one().condition == "new"

    assert fix_main(["--confirm"]) == 0
    db.expire_all()
    assert db.query(Product).one().condition == CONDITION_SHOWCASE


def test_ai_understands_showcase_request():
    assert extract_filters("витринный айфон подешевле").condition == CONDITION_SHOWCASE
    assert extract_filters("нужен новый айфон").condition == "new"
