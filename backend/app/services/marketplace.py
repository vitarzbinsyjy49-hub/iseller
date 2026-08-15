"""Изоляция «Маркетплейса» от обычного каталога.

Товары, которые пользователи предложили и магазин одобрил (см.
docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md), физически
живут в той же таблице products, но НЕ должны попадаться среди нового
ассортимента — в категориях, поиске, ИИ-подборе, секциях главной. Единая точка
исключения нужна, чтобы это правило не расползлось по десятку запросов и не
разъехалось (тот же класс бага, что уже был с захардкоженными категориями).

Разрез — ТОЛЬКО по source, не по condition: обычный б/у-товар магазина
(condition="used", source="manual") в «Маркетплейс» не входит и в обычном
каталоге остаётся как есть.
"""
from sqlalchemy import Select

from app.models.product import Product

MARKETPLACE_SOURCE = "user_submitted"


def exclude_marketplace(stmt: Select) -> Select:
    """Убрать из выдачи товары, предложенные пользователями через маркетплейс."""
    return stmt.where(Product.source != MARKETPLACE_SOURCE)
