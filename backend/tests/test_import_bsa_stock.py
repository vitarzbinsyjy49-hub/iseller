"""Сверка наличия с прайсом BSA: чего нет в прайсе — того нет в наличии."""
from app.models.product import Product
from app.scripts.import_bsa import sync_stock
from tests.conftest import make_product


def test_missing_from_price_goes_out_of_stock_and_back(db):
    make_product(db, sku="IP-17-256-BLACK-IN-SIM", source="bsa", in_stock=True)
    make_product(db, sku="IP-17-256-PINK-IN-SIM", source="bsa", in_stock=True)
    make_product(db, sku="IP-17-512-BLACK-IN-SIM", source="bsa", in_stock=False)
    # Не из BSA — сверка его не касается, даже если артикула нет в прайсе.
    make_product(db, sku="PREORDER-IP18PRO", source="seed", in_stock=True)

    off, on = sync_stock(db, {"IP-17-256-BLACK-IN-SIM", "IP-17-512-BLACK-IN-SIM"},
                         dry_run=False)

    assert off == ["IP-17-256-PINK-IN-SIM"]
    assert on == ["IP-17-512-BLACK-IN-SIM"]
    stock = {p.sku: p.in_stock for p in db.query(Product)}
    assert stock == {
        "IP-17-256-BLACK-IN-SIM": True, "IP-17-256-PINK-IN-SIM": False,
        "IP-17-512-BLACK-IN-SIM": True, "PREORDER-IP18PRO": True,
    }


def test_dry_run_changes_nothing(db):
    make_product(db, sku="IP-17-256-PINK-IN-SIM", source="bsa", in_stock=True)
    off, _ = sync_stock(db, set(), dry_run=True)
    assert off == ["IP-17-256-PINK-IN-SIM"]
    assert db.query(Product).one().in_stock is True
