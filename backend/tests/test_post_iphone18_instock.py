"""Пост «iPhone 18 в наличии»: цены из базы, снятие предзаказа, лимит подписи."""
from app.scripts import post_iphone18_instock as post
from tests.conftest import make_product


def _seed(db):
    make_product(db, sku="IP-18PRO-256-GLACIER-HK-SIM-ACT", title="18 Pro act", price=123000)
    make_product(db, sku="IP-18PRO-256-BLACK-KRHK-SIM", title="18 Pro", price=128500)
    make_product(db, sku="IP-18PRO-512-BLACK-KRHK-SIM", title="18 Pro 512", price=154500)
    make_product(db, sku="IP-18PROMAX-256-SILVER-KRHK-SIM", title="18 Pro Max", price=148500)
    # Дешевле всех, но выключена — в «от» попадать не должна.
    make_product(db, sku="IP-18PROMAX-256-BLACK-KW-ESIM", title="off", price=1000,
                 is_active=False)
    make_product(db, sku="PREORDER-IP18PRO", title="предзаказ", price=0,
                 availability_mode="preorder")


def test_body_takes_min_prices_and_keeps_models_apart(db):
    _seed(db)
    body = post.build_body(db)
    # «IP-18PRO-» не должен цеплять Pro Max, а активированный — обычную цену.
    assert "iPhone 18 Pro</b> — от 128 500 ₽" in body
    assert "iPhone 18 Pro Max</b> — от 148 500 ₽" in body
    assert "18 Pro от 123 000 ₽" in body
    assert post.plain_length(body) <= post.CAPTION_LIMIT


def test_prepare_retires_preorder_and_marks_new(db):
    _seed(db)
    row, changed = post.prepare(db, post.build_body(db), dry_run=True)
    from app.models.product import Product

    assert db.query(Product).filter_by(sku="PREORDER-IP18PRO").one().is_active is False
    assert db.query(Product).filter_by(sku="IP-18PRO-256-BLACK-KRHK-SIM").one().is_new
    assert row.image_url is None          # в предпросмотре картинку не кладём
    assert row.button_spec[0]["kind"] == "preorder"
