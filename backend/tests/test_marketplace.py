"""Изоляция «Маркетплейса»: пользовательские товары не смешиваются с обычным
каталогом (см. docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md)."""
from sqlalchemy import select

from app.models.product import Product
from app.services.marketplace import MARKETPLACE_SOURCE, exclude_marketplace
from tests.conftest import make_product


def test_exclude_marketplace_filters_by_source(db):
    regular = make_product(db, title="Обычный", source="manual")
    listed = make_product(db, title="С маркетплейса", source=MARKETPLACE_SOURCE)
    stmt = exclude_marketplace(select(Product))
    ids = {p.id for p in db.execute(stmt).scalars().all()}
    assert regular.id in ids
    assert listed.id not in ids


def test_exclude_marketplace_does_not_touch_used_condition_without_source(db):
    """condition="used" сам по себе НЕ маркетплейс — источник изоляции ТОЛЬКО source."""
    own_used_stock = make_product(db, title="Свой б/у", source="manual", condition="used")
    stmt = exclude_marketplace(select(Product))
    ids = {p.id for p in db.execute(stmt).scalars().all()}
    assert own_used_stock.id in ids


def test_exclude_marketplace_does_not_exclude_null_source(db):
    """source=NULL (from raw-SQL или legacy paths) НЕ маркетплейс — only MARKETPLACE_SOURCE excluded."""
    null_source = make_product(db, title="Без источника", source=None)
    stmt = exclude_marketplace(select(Product))
    ids = {p.id for p in db.execute(stmt).scalars().all()}
    assert null_source.id in ids
