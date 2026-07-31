"""Слежение за избранным: подешевело / снова в наличии (патч 1.1, фича #3).

Самая дорогая ошибка этой фичи — не «не отправили», а «отправили лишнее».
Избранное копится месяцами, и один неверный прогон разошлёт сотни сообщений
про товары, о которых человек не спрашивал. Поэтому три защиты, и все три
проверены тестами:

1. **Первый скан молчит.** У существующих строк отметки NULL: скан их
   ЗАПОЛНЯЕТ и не шлёт ничего. Иначе выкладка патча стала бы рассылкой «цена
   такая-то» по всему избранному всех пользователей разом.

2. **Отметка цены только убывает.** ``notified_price`` — это самая низкая цена,
   о которой мы уже сообщали. При росте цены она НЕ поднимается, поэтому
   колебание 100->90->100->90 даёт ровно одно сообщение, а не три.

3. **Порог.** Снижение меньше ``FAVORITE_PRICE_DROP_PERCENT`` — не новость.
   Уведомление про «минус 30 рублей» обесценивает следующее, настоящее.

Отдельно про честность формулировок: «снова в наличии» говорится ТОЛЬКО про
физическое наличие (``in_stock``/``limited``). Режимы ``on_request`` и
``preorder`` тоже orderable, но объявить их «снова в наличии» — соврать: товара
на складе нет, и человек придёт за тем, чего нет.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.favorite import ProductFavorite
from app.models.product import Product
from app.models.user import User
from app.services.availability import resolve_availability
from app.services.cart_reminders import is_quiet_hour
from app.services.notification_templates import favorite_message
from app.services.notifications import enqueue, notifications_enabled

logger = logging.getLogger("techshop.notifications")

#: Режимы, при которых товар физически есть на складе. Только про них честно
#: сказать «снова в наличии» — см. docstring модуля.
IN_STOCK_MODES = ("in_stock", "limited")


def in_stock_now(product: Product) -> bool:
    return resolve_availability(product) in IN_STOCK_MODES


def price_dropped(current: float, notified: float | None, percent: float | None = None) -> bool:
    """Достаточно ли снизилась цена, чтобы об этом стоило писать.

    ``notified is None`` — точки отсчёта нет, сравнивать не с чем: это случай
    первого скана, и он обязан молчать, а не считать снижением всё подряд.
    """
    if notified is None:
        return False
    threshold = settings.FAVORITE_PRICE_DROP_PERCENT if percent is None else percent
    if notified <= 0:
        return False
    drop = (float(notified) - float(current)) / float(notified) * 100.0
    return drop >= threshold


def _candidates(db: Session, limit: int) -> list[tuple[ProductFavorite, Product, User]]:
    """Избранное для проверки — БЕЗ отбора «кому есть что сказать» в SQL.

    Здесь была попытка сузить выборку условием вида «цена упала ИЛИ отметка
    наличия False». Она отсекала товар, который ТОЛЬКО ЧТО ушёл со склада: его
    цена не менялась, а отметка ещё True, поэтому строка в выборку не попадала и
    отметка не сбрасывалась в False. Следующее поступление после этого уже не
    считалось новостью — то есть человек, отметивший товар именно ради
    возвращения, не узнавал о нём никогда. Тест
    `test_going_out_of_stock_resets_the_flag` держит этот случай.

    Причина ошибки общая: наличие выводится в Python из четырёх флагов плюс
    явной колонки (`availability.resolve_availability`), и любое его повторение
    в SQL — вторая версия правила, которая рано или поздно разъедется с первой.
    Поэтому фильтра нет: строки читаются целиком, решение принимает Python.

    Масштаб это выдерживает: избранное магазина — тысячи строк, скан идёт раз в
    час. Если строк станет заметно больше, `limit` начнёт срезать хвост — и
    тогда об этом будет сказано в лог, а не пропущено молча.
    """
    rows = db.execute(
        select(ProductFavorite, Product, User)
        .join(Product, Product.id == ProductFavorite.product_id)
        .join(User, User.id == ProductFavorite.user_id)
        .order_by(ProductFavorite.id.asc())
        .limit(limit)
    ).all()
    if len(rows) >= limit:
        logger.warning(
            "скан избранного упёрся в предел %s строк — часть избранного не "
            "проверена; поднимите FAVORITE_WATCH_LIMIT", limit,
        )
    return [(fav, product, user) for fav, product, user in rows]


def scan(db: Session, *, now: datetime | None = None, limit: int | None = None) -> dict:
    """Поставить уведомления по избранному в очередь. Ничего не отправляет.

    Возвращает счётчики: ``initialized`` — сколько отметок заполнено молча
    (первый скан), ``queued`` — сколько сообщений поставлено.
    """
    stats = {"checked": 0, "initialized": 0, "queued": 0, "skipped": 0}
    if not (settings.FAVORITE_WATCH_ENABLED and notifications_enabled()):
        return stats

    moment = now or datetime.now(timezone.utc)
    batch = settings.FAVORITE_WATCH_LIMIT if limit is None else limit
    quiet = is_quiet_hour(moment)

    for fav, product, user in _candidates(db, batch):
        stats["checked"] += 1
        price = float(product.price)
        available = in_stock_now(product)

        # --- Первое знакомство: запоминаем состояние и МОЛЧИМ ---------------
        # Строка без отметок появилась либо до патча, либо в обход API. В обоих
        # случаях сообщать нечего: мы не знаем, что человек уже видел.
        if fav.notified_price is None or fav.notified_in_stock is None:
            fav.notified_price = price
            fav.notified_in_stock = available
            stats["initialized"] += 1
            continue

        previous_price = float(fav.notified_price)
        cheaper = price_dropped(price, previous_price)
        back_in_stock = available and not fav.notified_in_stock

        # Наличие фиксируем ВСЕГДА, даже когда не пишем: товар, ушедший со
        # склада, обязан вернуть отметку в False, иначе следующее поступление
        # не будет распознано как новость.
        fav.notified_in_stock = available

        if not (cheaper or back_in_stock):
            # Отметку цены при росте НЕ трогаем — она только убывает.
            stats["skipped"] += 1
            continue

        # Снятый с публикации товар отметку наличия уже сбросил (её надо было
        # обновить), но новостью не является: звать в карточку, которой на
        # витрине нет, нельзя. Цену тоже не фиксируем — если товар вернут,
        # снижение обязано остаться новостью.
        if not product.is_active:
            stats["skipped"] += 1
            continue

        if not user.telegram_id or quiet:
            # Тихие часы: состояние уже обновлено, но сообщение не ставим.
            # Цену при этом не фиксируем — снижение не должно пропасть, оно
            # уедет в следующий дневной скан.
            stats["skipped"] += 1
            continue

        message = favorite_message(
            product_id=product.id,
            title=product.title,
            price=price,
            previous_price=previous_price if cheaper else None,
            back_in_stock=back_in_stock,
        )
        # Ключ различает обе новости и обе привязаны к конкретному событию:
        # цена — к самой цене (о ней сообщаем один раз), наличие — к дате
        # (мигающий склад не превратится в поток сообщений).
        key = (
            f"fav:{fav.id}:instock:{moment.date().isoformat()}"
            if back_in_stock
            else f"fav:{fav.id}:price:{price:.2f}"
        )
        row = enqueue(
            db, chat_id=user.telegram_id, kind="favorite_price",
            message=message, dedupe_key=key,
        )
        if row is None:
            stats["skipped"] += 1
        else:
            stats["queued"] += 1

        if cheaper:
            fav.notified_price = price

    db.commit()
    # Логирует вызывающий код (_tick в bot_polling) — и логирует ВСЕГДА, даже
    # пустой результат. Второй лог здесь дал бы дубль на каждую находку.
    return stats
