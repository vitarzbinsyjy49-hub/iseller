"""Детерминированный, объяснимый движок рекомендаций (v5.2.6).

Без ML: веса событий + затухание по времени -> аффинности (категория/бренд/
модельная семья/ценовой диапазон) -> скоринг кандидатов -> дедуп вариантов и
ограничения разнообразия. Три режима: новый пользователь (популярное/новинки/
разнообразие), есть просмотры (эксплуатация+исследование), есть избранное/заявки
(сильнее модель/бренд/цена). Всё прозрачно и тестируемо.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.product import Product
from app.models.user_product_event import EVENT_TYPES, UserProductEvent
from app.services.image_groups import dedupe_by_group, has_real_photo, resolve_product_images

# Веса сигналов (прозрачные, объяснимые). Заявка/избранное — сильные, просмотр —
# слабый, повторный просмотр накапливается суммой. Снятие из избранного — лёгкий
# минус, но категорию навсегда не блокирует.
_WEIGHT = {
    "lead_created": 6.0,
    "favorite_add": 4.0,
    "recommendation_click": 2.0,
    "category_view": 1.5,
    "product_view": 1.0,
    "search": 0.5,
    "favorite_remove": -2.0,
}
_HALF_LIFE_DAYS = 21.0     # недавнее весит сильнее старого
_WINDOW_DAYS = 90          # события старше окна не учитываем
_DEDUP_WINDOW_SECONDS = 120  # повторный одинаковый product_view в этом окне не пишем


# ==================== запись событий ====================

def record_event(db: Session, user_id: int, event_type: str, *, product_id=None,
                 category=None, query=None, source=None) -> bool:
    """Записать событие (allowlist + дедуп + нормализация). Возвращает True, если
    записано; False, если тип неизвестен или это дубль в коротком окне."""
    if event_type not in EVENT_TYPES:
        return False
    cat = (category or "").strip()[:100] or None
    q = (query or "").strip().lower()[:120] or None
    src = (source or "").strip()[:40] or None

    if product_id is not None:
        threshold = datetime.utcnow() - timedelta(seconds=_DEDUP_WINDOW_SECONDS)
        last = db.execute(
            select(UserProductEvent.created_at)
            .where(UserProductEvent.user_id == user_id,
                   UserProductEvent.event_type == event_type,
                   UserProductEvent.product_id == product_id)
            .order_by(UserProductEvent.created_at.desc()).limit(1)
        ).scalar()
        if last is not None and _age_seconds(last) < _DEDUP_WINDOW_SECONDS:
            return False
        # threshold используется как страховка на случай, если БД не отдала tz
        _ = threshold

    db.add(UserProductEvent(user_id=user_id, event_type=event_type, product_id=product_id,
                            category=cat, query_normalized=q, source=src))
    db.commit()
    return True


def _age_seconds(dt: datetime) -> float:
    now = datetime.utcnow()
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return max(0.0, (now - dt).total_seconds())


# ==================== недавно просмотренные ====================

def recently_viewed(db: Session, user_id: int, limit: int = 10) -> list[Product]:
    """Последние просмотренные активные товары, дедуп по product_id (сохраняя
    порядок последнего просмотра). Для секции «Вы недавно смотрели»."""
    rows = db.execute(
        select(UserProductEvent.product_id)
        .where(UserProductEvent.user_id == user_id,
               UserProductEvent.event_type == "product_view",
               UserProductEvent.product_id.is_not(None))
        .order_by(UserProductEvent.created_at.desc()).limit(200)
    ).scalars().all()
    ordered_ids: list[int] = []
    seen: set[int] = set()
    for pid in rows:
        if pid not in seen:
            seen.add(pid)
            ordered_ids.append(pid)
        if len(ordered_ids) >= limit * 3:
            break
    if not ordered_ids:
        return []
    by_id = {p.id: p for p in db.execute(
        select(Product).where(Product.id.in_(ordered_ids), Product.is_active.is_(True))
    ).scalars().all()}
    return [by_id[i] for i in ordered_ids if i in by_id][:limit]


# ==================== скоринг ====================

@dataclass
class Affinity:
    category: dict[str, float] = field(default_factory=dict)
    brand: dict[str, float] = field(default_factory=dict)
    groups: dict[str, float] = field(default_factory=dict)
    viewed_ids: set[int] = field(default_factory=set)
    recent_ids: set[int] = field(default_factory=set)   # самые свежие просмотры (исключаем из «Для вас»)
    price_ref: float | None = None

    @property
    def is_empty(self) -> bool:
        return not (self.category or self.brand or self.groups)


def _build_affinity(db: Session, events: list[UserProductEvent]) -> Affinity:
    aff = Affinity()
    if not events:
        return aff
    prices: list[float] = []
    product_ids = {e.product_id for e in events if e.product_id}
    products = {p.id: p for p in db.execute(
        select(Product).where(Product.id.in_(product_ids))
    ).scalars().all()} if product_ids else {}

    recent_sorted = sorted((e for e in events if e.event_type == "product_view" and e.product_id),
                           key=lambda e: e.created_at, reverse=True)
    aff.recent_ids = {e.product_id for e in recent_sorted[:4]}

    for e in events:
        w = _WEIGHT.get(e.event_type, 0.0) * (0.5 ** (_age_seconds(e.created_at) / 86400.0 / _HALF_LIFE_DAYS))
        if w == 0.0:
            continue
        p = products.get(e.product_id) if e.product_id else None
        cat = (p.category if p else None) or e.category
        if cat:
            aff.category[cat] = aff.category.get(cat, 0.0) + w
        if p:
            aff.viewed_ids.add(p.id)
            if p.brand:
                aff.brand[p.brand] = aff.brand.get(p.brand, 0.0) + w
            if p.image_group_key:
                aff.groups[p.image_group_key] = aff.groups.get(p.image_group_key, 0.0) + w
            if w > 0 and p.price:
                prices.append(float(p.price))
    if prices:
        prices.sort()
        aff.price_ref = prices[len(prices) // 2]  # медиана интересовавших цен
    return aff


def _score(p: Product, aff: Affinity) -> float:
    s = aff.category.get(p.category, 0.0) * 1.0
    s += aff.brand.get(p.brand, 0.0) * 0.8
    if p.image_group_key and p.image_group_key in aff.groups:
        s += aff.groups[p.image_group_key] * 1.2      # близкая модельная семья
    if aff.price_ref and p.price:
        ratio = float(p.price) / aff.price_ref
        if 0.5 <= ratio <= 1.7:
            s += 2.0 * (1.0 - abs(1.0 - ratio))        # ближе к привычной цене — выше
    s += (p.popularity or 0.0) * 0.05                  # популярность — мягкий приор
    if p.is_new:
        s += 0.5
    if not p.in_stock:
        s -= 1.0
    return s


def _diversify(products: list[Product], limit: int,
               max_share: float = 0.4, max_consecutive: int = 2) -> list[Product]:
    """Дедуп вариантов по группе + ограничения разнообразия: доля одной категории
    <= max_share, не более max_consecutive подряд из одной категории. Переполнение
    откладывается и добирается в конце, если не хватает до limit."""
    products = dedupe_by_group(products)
    cap = max(2, int(limit * max_share))
    out: list[Product] = []
    deferred: list[Product] = []
    counts: dict[str, int] = {}
    streak_cat: str | None = None
    streak = 0
    for p in products:
        if len(out) >= limit:
            break
        c = p.category or "_"
        if counts.get(c, 0) >= cap or (c == streak_cat and streak >= max_consecutive):
            deferred.append(p)
            continue
        out.append(p)
        counts[c] = counts.get(c, 0) + 1
        streak = streak + 1 if c == streak_cat else 1
        streak_cat = c
    for p in deferred:
        if len(out) >= limit:
            break
        out.append(p)
    return out[:limit]


def _reason_for(p: Product, aff: Affinity, default: str) -> str:
    if p.image_group_key and p.image_group_key in aff.groups:
        return "similar_brand"
    if aff.brand.get(p.brand):
        return "similar_brand"
    if aff.category.get(p.category):
        return "similar_category"
    if p.is_new:
        return "new"
    if p.in_stock and p.is_available_today:
        return "available_today"
    return default


def recommend(db: Session, user_id: int, limit: int = 12) -> tuple[list[Product], dict[int, str], str]:
    """Персональные рекомендации: (товары, {product_id: reason_key}, mode).

    Режимы: 'cold' (нет истории) / 'views' (есть просмотры) / 'intent' (избранное/
    заявки). Смесь эксплуатации и исследования обеспечивается скорингом + дедупом
    и ограничениями разнообразия (не только одна категория, не варианты-дубли).
    """
    since = datetime.utcnow() - timedelta(days=_WINDOW_DAYS)
    events = db.execute(
        select(UserProductEvent)
        .where(UserProductEvent.user_id == user_id, UserProductEvent.created_at >= since)
    ).scalars().all()
    aff = _build_affinity(db, events)

    candidates = db.execute(
        select(Product).where(Product.is_active.is_(True))
    ).scalars().all()
    # v5.4.1: «Для вас» рендерится на главной — товары без реального фото туда
    # не попадают вовсе (как и остальные секции /catalog/feed).
    resolved = resolve_product_images(db, candidates)
    candidates = [p for p in candidates if has_real_photo(resolved.get(p.id))]

    if aff.is_empty:
        mode = "cold"
        ranked = sorted(candidates, key=lambda p: (0 if p.in_stock else 1, -(p.popularity or 0),
                                                   0 if p.is_new else 1, p.id))
        default_reason = "popular"
    else:
        has_intent = any(e.event_type in ("favorite_add", "lead_created") for e in events)
        mode = "intent" if has_intent else "views"
        ranked = sorted(candidates, key=lambda p: (-_score(p, aff), 0 if p.in_stock else 1,
                                                   -(p.popularity or 0), p.id))
        default_reason = "based_on_views"
        # не рекомендуем только что просмотренные (пусть «Для вас» показывает новое)
        ranked = [p for p in ranked if p.id not in aff.recent_ids]

    diverse = _diversify(ranked, limit)
    reasons = {p.id: (_reason_for(p, aff, default_reason) if mode != "cold"
                      else ("new" if p.is_new else "popular")) for p in diverse}
    return diverse, reasons, mode
