"""Социальное доказательство на карточке товара (патч 1.1, фича #6).

Показываем ТОЛЬКО то, что действительно посчитано по реальным записям. Никаких
«3 человека смотрят прямо сейчас» и «осталось 2 штуки»: выдуманная срочность —
это ложь от имени магазина, а проект её не допускает нигде (денежные утверждения
вырезаются из ответов AI, категории не подставляются по умолчанию).

## Почему не analytics_events и не user_product_events

Соблазн велик: в `user_product_events` уже лежат `product_view`, `favorite_add`
и `lead_created` с индексом по `product_id` — считай да показывай. Нельзя.

`POST /api/events/product` принимает `event_type` из общего allowlist, и туда
входят В ТОМ ЧИСЛЕ `favorite_add` и `lead_created`. Для персональных
рекомендаций это безопасно: подделывая события, человек портит собственную
выдачу и ничью больше. Но число, которое видят ВСЕ покупатели, из
клиентописуемой таблицы брать нельзя — любой авторизованный клиент накрутил бы
любому товару любую популярность, и магазин показывал бы чужую ложь как свою
правду.

Поэтому источник — сами таблицы фактов:

| сигнал | источник | почему ему можно верить |
|---|---|---|
| заказы | `lead_items` + `leads` | заявка попадает к менеджеру; накрутка = спам, который видно |
| избранное | `product_favorites` | UNIQUE (user_id, product_id): один человек = ровно один голос |

## Что считается заказом

Оба вида заявок. У заявки-корзины товары лежат в `lead_items`, у одиночной —
в `leads.product_id`. Считать только первый вид — тихо потерять большую часть
реального спроса (на проде на момент написания: 3 заявки, 0 позиций корзины,
то есть ВСЕ заказы были бы не посчитаны).

Отменённые заявки исключены: «заказывали 8 раз», где половина отменена, — это
уже преувеличение, а не факт.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.favorite import ProductFavorite
from app.models.lead import Lead
from app.models.lead_item import LeadItem


def _plural(count: int, one: str, few: str, many: str) -> str:
    tail = count % 100
    if 11 <= tail <= 14:
        return many
    match count % 10:
        case 1:
            return one
        case 2 | 3 | 4:
            return few
        case _:
            return many


def order_counts(
    db: Session, product_ids: list[int], *, now: datetime | None = None,
    window_days: int | None = None,
) -> dict[int, int]:
    """Сколько РАЗНЫХ заявок включали каждый товар за окно.

    Считаем заявки, а не позиции: «заказывали 5 раз» про пять штук в одной
    корзине одного человека — неправда. UNION склеивает оба вида заявок и сам
    убирает дубли, если товар вдруг попал и в `leads.product_id`, и в позиции.
    """
    if not product_ids:
        return {}
    moment = now or datetime.now(timezone.utc)
    days = settings.SOCIAL_PROOF_ORDER_WINDOW_DAYS if window_days is None else window_days
    since = moment - timedelta(days=days)

    from_items = (
        select(LeadItem.product_id.label("pid"), LeadItem.lead_id.label("lid"))
        .join(Lead, Lead.id == LeadItem.lead_id)
        .where(
            LeadItem.product_id.in_(product_ids),
            Lead.status != "cancelled",
            Lead.created_at >= since,
        )
    )
    from_leads = (
        select(Lead.product_id.label("pid"), Lead.id.label("lid"))
        .where(
            Lead.product_id.in_(product_ids),
            Lead.status != "cancelled",
            Lead.created_at >= since,
        )
    )
    unioned = from_items.union(from_leads).subquery()
    rows = db.execute(
        select(unioned.c.pid, func.count(func.distinct(unioned.c.lid)))
        .group_by(unioned.c.pid)
    ).all()
    return {pid: int(n) for pid, n in rows if pid is not None}


def favorite_counts(db: Session, product_ids: list[int]) -> dict[int, int]:
    """Сколько РАЗНЫХ людей держат товар в избранном.

    Накрутить повторами нельзя: уникальный индекс (user_id, product_id) не даст
    одному человеку добавить товар дважды.
    """
    if not product_ids:
        return {}
    rows = db.execute(
        select(ProductFavorite.product_id, func.count(func.distinct(ProductFavorite.user_id)))
        .where(ProductFavorite.product_id.in_(product_ids))
        .group_by(ProductFavorite.product_id)
    ).all()
    return {pid: int(n) for pid, n in rows}


def social_proof_label(*, orders: int = 0, favorites: int = 0) -> str | None:
    """Одна честная строка про товар, либо None.

    Одна, а не список: три бейджа подряд читаются как реклама и обесценивают
    друг друга. Заказы важнее избранного — это состоявшееся намерение купить,
    а не закладка.

    Пороги обязательны и работают в обе стороны: «заказывали 1 раз» и «1 человек
    добавил в избранное» — антиреклама, а на крошечных числах ещё и намёк на
    конкретного человека.
    """
    if not settings.SOCIAL_PROOF_ENABLED:
        return None
    if orders >= settings.SOCIAL_PROOF_MIN_ORDERS:
        word = _plural(orders, "раз", "раза", "раз")
        return f"Заказывали {orders} {word} за месяц"
    if favorites >= settings.SOCIAL_PROOF_MIN_FAVORITES:
        # «В избранном у N человек», а не «N человек добавили в избранное»:
        # второй вариант при любых числах шире плитки каталога (169–180px против
        # доступных 149px) и обрезался бы многоточием. Обрезанное социальное
        # доказательство не работает, а заводить ВТОРОЙ текст для плитки значит
        # получить две версии одного утверждения, которые со временем разойдутся.
        word = _plural(favorites, "человека", "человек", "человек")
        return f"В избранном у {favorites} {word}"
    return None


def apply_social_proof(db: Session, products, payloads: list[dict]) -> None:
    """Проставить `social_proof` в готовые словари карточек.

    Тот же приём, что у `apply_group_images`: ДВА запроса на весь ответ
    независимо от числа карточек, а не по паре запросов на карточку. Ключ
    появляется всегда (пусть и `None`) — иначе фронту пришлось бы отличать
    «не посчитали» от «нечего показать».
    """
    ids = [p.id for p in products]
    if not ids:
        return
    orders = order_counts(db, ids)
    favorites = favorite_counts(db, ids)
    for product, payload in zip(products, payloads):
        payload["social_proof"] = social_proof_label(
            orders=orders.get(product.id, 0),
            favorites=favorites.get(product.id, 0),
        )
