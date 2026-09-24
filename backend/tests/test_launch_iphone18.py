from app.models.home import HomeBanner
from app.models.product import Product
from app.scripts import launch_iphone18 as launch
from tests.conftest import make_product


def test_launch_switches_banner_retires_preorder_marks_new(db):
    db.add(HomeBanner(title="Шесть новых устройств", action_type="preorder",
                      action_value="apple-sept-2026", position=0))
    db.commit()
    make_product(db, sku="PREORDER-IP18PRO", availability_mode="preorder", price=0)
    make_product(db, sku="PREORDER-IPDUO", availability_mode="preorder", price=0)
    make_product(db, sku="IP-18PROMAX-256-BLACK-KRHK-SIM", source="bsa")

    assert launch.apply(db)
    banner = db.query(HomeBanner).one()
    assert banner.title == launch.BANNER["title"]
    assert banner.image_url == launch.BANNER["image_url"]
    active = {p.sku: p.is_active for p in db.query(Product)}
    assert active["PREORDER-IP18PRO"] is False and active["PREORDER-IPDUO"] is True
    assert db.query(Product).filter_by(sku="IP-18PROMAX-256-BLACK-KRHK-SIM").one().is_new
    assert launch.apply(db) == []          # повторный запуск ничего не меняет
