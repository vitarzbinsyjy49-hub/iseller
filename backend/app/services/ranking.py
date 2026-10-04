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
0.5. предзаказ — анонсированное, но не приехавшее. Стоит выше `in_stock`
   СОЗНАТЕЛЬНО и временно: у предзаказа `in_stock=False` по определению, и без
   этой ступени шесть свежих устройств оказались бы в самом низу каталога —
   формально они там есть, практически их никто не увидит. Ступень снимается
   одной правкой здесь же, когда товары приедут и станут обычными;
1. `in_stock` — то, что нельзя купить, вниз;
1.5. `promo_boost` — редакторское продвижение: поднять СТАРЫЙ товар руками.
   Выше спроса и новизны, но ниже наличия. Ставится скриптом/админкой;
1.7. новизна модели (services/novelty) — свежие модели (первое появление не
   раньше окна) выше несвежих, среди свежих более новая выше. У несвежих
   ступень одинаковая — решение уходит в спрос, а не в «кто старше». Раньше
   эту работу делал promo_boost, и всё зависело от того, не забудут ли его
   поставить и снять; теперь у новинки без просмотров место есть само;
2. `popularity` — реальный спрос (просмотры за VIEW_WINDOW_DAYS, пересчёт раз
   в сутки в цикле бота). Ноль у всех => шаг не работает, и решение переходит
   дальше;
3. позиция категории из плиток; категория без плитки — в конец, но НЕ пропадает;
4. цена по убыванию — внутри категории вперёд выходит старшая модель;
5. `id` — чтобы не осталось ни одной неразличимой пары. Без этого шага равные
   ключи снова дают произвольный порядок, то есть исходную проблему.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models.home import HomeCategory
from app.models.product import Product
from app.services.availability import resolve_availability
from app.models.user_product_event import UserProductEvent
from app.services.catalog_nav import SALE_KEY
from app.services.novelty import as_utc, novelty_cutoff

#: Ранг категории, для которой плитки нет. Заведомо больше любой позиции.
NO_TILE_RANK = 10_000

#: Окно, за которое считаем просмотры для popularity. Старые просмотры выпадают
#: из счёта сами при следующем пересчёте — отдельной ручки «забыть» не нужно.
VIEW_WINDOW_DAYS = 90


def view_counts(db: Session, window_days: int = VIEW_WINDOW_DAYS) -> dict[int, int]:
    """{product_id: число просмотров за window_days} — источник для Product.popularity.

    `product_view` пишется через тот же клиентский `POST /api/events/product`,
    что и остальные события recommendations.py. `services/social_proof.py`
    сознательно не берёт эти события для чисел, которые ВИДИТ покупатель
    («Заказывали N раз») — подкрутка там была бы прямой ложью витрины. Здесь
    другое: popularity — это внутренний сигнал порядка выдачи, не заявление
    факта; подкрутка сдвинет ранжирование, а не соврёт покупателю напрямую.
    На заказы (`social_proof.order_counts`) и избранное сигнал не переводим —
    их пока единицы, признак попросту не наберёт данных.
    """
    since = datetime.now(timezone.utc) - timedelta(days=window_days)
    rows = db.execute(
        select(UserProductEvent.product_id, func.count())
        .where(UserProductEvent.event_type == "product_view",
               UserProductEvent.product_id.is_not(None),
               UserProductEvent.created_at >= since)
        .group_by(UserProductEvent.product_id)
    ).all()
    return {pid: int(n) for pid, n in rows}


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


def _novelty_rank(product: Product, cutoff: datetime) -> float:
    """Ступень новизны для Python: -timestamp у свежих (новее = меньше = выше),
    +inf у остальных — все несвежие равны, как NULL в SQL-варианте ниже."""
    seen = as_utc(product.model_first_seen_at)
    if seen is None or seen < cutoff:
        return float("inf")
    return -seen.timestamp()


def product_sort_key(product: Product, priority: dict[str, int],
                     cutoff: datetime | None = None) -> tuple:
    """Ключ сортировки для питоновской сортировки (рекомендации, дедуп).

    `cutoff` — граница окна новизны; передайте один на всю сортировку, если
    важна точная граница (иначе он берётся из часов на каждый товар)."""
    try:
        price = float(product.price or 0)
    except (TypeError, ValueError):
        price = 0.0
    return (
        0 if product.is_legendary else 1,
        0 if resolve_availability(product) == "preorder" else 1,
        0 if product.in_stock else 1,
        -int(product.promo_boost or 0),
        _novelty_rank(product, cutoff or novelty_cutoff()),
        -float(product.popularity or 0),
        priority.get(product.category, NO_TILE_RANK),
        -price,
        product.id or 0,
    )


def novelty_order(cutoff: datetime | None = None):
    """Ступень новизны для SQL: дата у свежих, NULL у остальных, NULL — в конец.
    Нужна и сама по себе — секции «Новинки» и подбору ИИ «что нового»."""
    cutoff = cutoff or novelty_cutoff()
    return case(
        (Product.model_first_seen_at >= cutoff, Product.model_first_seen_at), else_=None,
    ).desc().nulls_last()


def order_by_clauses(priority: dict[str, int], cutoff: datetime | None = None):
    """То же правило для SQL: список выражений для `stmt.order_by(*...)`."""
    if priority:
        rank = case(priority, value=Product.category, else_=NO_TILE_RANK)
    else:
        rank = case((Product.id.is_(None), NO_TILE_RANK), else_=NO_TILE_RANK)
    return [
        Product.is_legendary.desc(),
        # Питоновский ключ выводит режим через resolve_availability, а SQL
        # сравнивает колонку напрямую. Расхождения нет: `preorder` — режим
        # ЯВНЫЙ, вывести его из флагов нельзя, он бывает только в колонке.
        case((Product.availability_mode == "preorder", 0), else_=1).asc(),
        Product.in_stock.desc(),
        Product.promo_boost.desc(),
        novelty_order(cutoff),
        Product.popularity.desc(),
        rank.asc(),
        Product.price.desc(),
        Product.id.asc(),
    ]


def default_order(db: Session):
    """Готовый порядок выдачи по умолчанию — один вызов на запрос."""
    return order_by_clauses(category_priority(db))


def recompute_popularity(db: Session, *, dry_run: bool = False) -> int:
    """Пересчитать `Product.popularity` из просмотров за VIEW_WINDOW_DAYS.

    Вынесено из scripts/recompute_popularity.py: скрипт был, но его никто не
    запускал — ни таймера, ни цикла, и 298 просмотров за 90 дней лежали без
    пользы. Теперь его раз в сутки зовёт цикл бота, скрипт остался обёрткой
    для ручного прогона.

    Идемпотентно: каждый прогон считает значение по окну целиком, старые
    просмотры выпадают сами. Только активные товары — как и раньше. Возвращает
    число изменившихся; `dry_run` ничего не пишет (предпросмотр скрипта).
    """
    counts = view_counts(db, window_days=VIEW_WINDOW_DAYS)
    products = db.query(Product).filter(Product.is_active.is_(True)).all()
    changed = 0
    for product in products:
        new_value = float(counts.get(product.id, 0))
        if float(product.popularity or 0) != new_value:
            changed += 1
            if not dry_run:
                product.popularity = new_value
    if changed and not dry_run:
        db.commit()
    return changed
