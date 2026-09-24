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


def test_region_change_retargets_the_card_instead_of_hiding_it(db):
    """BSA сменил регион у того же аппарата — карточка переезжает, а не гаснет."""
    from app.scripts.import_bsa import retarget_regions

    make_product(db, sku="IP-17-256-BLACK-US-ESIM", source="bsa", price=71500,
                 title="Apple iPhone 17 256 ГБ Black (US, eSIM)")
    make_product(db, sku="MU9D3-INUSHK", source="bsa", price=63000, title="Mac Mini M4 (16/256)")
    # У этого два кандидата — угадывать нельзя, остаётся как есть.
    make_product(db, sku="IP-17-512-BLUE-JP-ESIM", source="bsa", price=90000, title="x")
    # Новый регион уже заведён отдельной карточкой — переименовать нельзя (дубль).
    make_product(db, sku="IP-17-256-WHITE-US-ESIM", source="bsa", price=1, title="old")
    make_product(db, sku="IP-17-256-WHITE-USJP-ESIM", source="bsa", price=2, title="new")

    price = {
        "IP-17-256-BLACK-USJP-ESIM": (78000, "Apple iPhone 17 256 ГБ Black (US-JP, eSIM)"),
        "MU9D3-US": (72500, "Apple Mac Mini M4 (16/256) (US)"),
        "IP-17-512-BLUE-US-ESIM": (94000, "a"), "IP-17-512-BLUE-USJP-ESIM": (94000, "b"),
        "IP-17-256-WHITE-USJP-ESIM": (77500, "new"),
    }
    moved = retarget_regions(db, price, dry_run=False)

    assert sorted(moved) == [("IP-17-256-BLACK-US-ESIM", "IP-17-256-BLACK-USJP-ESIM"),
                             ("MU9D3-INUSHK", "MU9D3-US")]
    row = db.query(Product).filter_by(sku="IP-17-256-BLACK-USJP-ESIM").one()
    assert row.price == 78000 and row.title.endswith("(US-JP, eSIM)")
    assert db.query(Product).filter_by(sku="IP-17-512-BLUE-JP-ESIM").one()
