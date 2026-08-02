"""Порядок выдачи каталога: спрос, а когда его нет — редакторский приор.

`popularity` — честное число: оно должно приходить из реального спроса (заказы,
избранное, просмотры) или из выгрузки магазина. Пока спроса нет, оно нулевое у
всех товаров, и `ORDER BY popularity DESC` вырождается — порядок фактически
задаёт физический порядок строк, наверх выходит то, что импортировали первым.
Из-за этого на витрине в «Популярном» оказывались наушники.

Список «что важнее» в коде — не выход: он разъедется с базой ровно так же, как
когда-то разъехался захардкоженный список категорий (см. `catalog_nav`). Поэтому
приор берётся из решения, которое уже принято и уже редактируется в админке —
**порядка плиток на главной** (`home_categories.position`). Хотите поднять Dyson
выше — двигаете плитку, а не правите код.

Ключ сортировки, от главного к второстепенному:

0. `is_legendary` — закреплённые позиции. Стоят выше ВСЕГО, включая наличие:
   легендарный товар снимают с витрины через `is_active`, а не роняя его вниз
   молча. Работает, пока таких позиций единицы;
1. `in_stock` — то, что нельзя купить, вниз;
2. `popularity` — реальный спрос, если он есть. Ноль у всех => шаг не работает,
   и решение переходит дальше;
3. позиция категории из плиток; категория без плитки — в конец, но НЕ пропадает;
4. цена по убыванию — внутри категории вперёд выходит старшая модель;
5. `id` — чтобы не осталось ни одной неразличимой пары. Без этого шага равные
   ключи снова дают произвольный порядок, то есть исходную проблему.
"""
from sqlalchemy import case, select
from sqlalchemy.orm import Session

from app.models.home import HomeCategory
from app.models.product import Product
from app.services.catalog_nav import SALE_KEY

#: Ранг категории, для которой плитки нет. Заведомо больше любой позиции.
NO_TILE_RANK = 10_000


def category_priority(db: Session) -> dict[str, int]:
    """{категория: позиция} из активных плиток главной.

    Берём только `action_type='category'`: ось брендов задаёт другой разрез, а
    `__sale__` — виртуальная категория, у товара её в поле нет.
    """
    rows = db.execute(
        select(HomeCategory.action_value, HomeCategory.position)
        .where(HomeCategory.is_active.is_(True), HomeCategory.action_type == "category")
    ).all()
    return {value: position for value, position in rows
            if value and value != SALE_KEY}


def product_sort_key(product: Product, priority: dict[str, int]) -> tuple:
    """Ключ сортировки для питоновской сортировки (рекомендации, дедуп)."""
    try:
        price = float(product.price or 0)
    except (TypeError, ValueError):
        price = 0.0
    return (
        0 if product.is_legendary else 1,
        0 if product.in_stock else 1,
        -float(product.popularity or 0),
        priority.get(product.category, NO_TILE_RANK),
        -price,
        product.id or 0,
    )


def order_by_clauses(priority: dict[str, int]):
    """То же правило для SQL: список выражений для `stmt.order_by(*...)`."""
    if priority:
        rank = case(priority, value=Product.category, else_=NO_TILE_RANK)
    else:
        rank = case((Product.id.is_(None), NO_TILE_RANK), else_=NO_TILE_RANK)
    return [
        Product.is_legendary.desc(),
        Product.in_stock.desc(),
        Product.popularity.desc(),
        rank.asc(),
        Product.price.desc(),
        Product.id.asc(),
    ]


def default_order(db: Session):
    """Готовый порядок выдачи по умолчанию — один вызов на запрос."""
    return order_by_clauses(category_priority(db))
