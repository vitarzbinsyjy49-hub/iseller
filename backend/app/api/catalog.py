"""Каталог: экспорт для AI Engine и публичный поиск.

GET /api/catalog/export  — служебный. Отдаёт весь каталог в формате Data Contract v1.
                           Защищён отдельным ключом X-API-Key (CATALOG_EXPORT_API_KEY):
                           это server-to-server канал, JWT пользователя тут не при чём.
GET /api/catalog/search  — публичный (JWT). Простой поиск без LLM. Используется:
                           1) как fallback, когда AI Engine недоступен;
                           2) фронтендом напрямую при полном отказе AI-роута.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import Text, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.product import Product
from app.models.user import User
from app.services.image_groups import (
    apply_group_images,
    dedupe_by_group,
    has_real_photo,
    resolve_product_images,
)
from app.services.catalog_nav import list_categories
from app.services.recommendations import recently_viewed, recommend
from app.services.social_proof import apply_social_proof

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/export")
def export_catalog(
    updated_since: str | None = None,
    x_api_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    if not settings.catalog_export_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Catalog export is not configured")
    if x_api_key != settings.catalog_export_api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid API key")

    query = select(Product)
    if updated_since:
        try:
            since = datetime.fromisoformat(updated_since)
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "updated_since must be ISO 8601")
        query = query.where(Product.updated_at > since)

    products = db.execute(query.order_by(Product.id)).scalars().all()
    return [p.to_export() for p in products]


# Разговорные алиасы -> слова, которые реально встречаются в title/brand.
# Нужны для live-поиска: "ps5" не подстрока "PlayStation 5", а искать её должны.
_SEARCH_ALIASES = {
    "ps5": "playstation", "ps4": "playstation", "пс5": "playstation", "пс": "playstation",
    "плейстейшн": "playstation", "плойка": "playstation", "сони": "sony",
    "айфон": "iphone", "iph": "iphone", "афон": "iphone",
    "макбук": "macbook", "мак": "macbook", "mac": "macbook", "мбп": "macbook",
    "аирподс": "airpods", "аирподсы": "airpods", "эирподс": "airpods", "наушники-tws": "airpods",
    "эпл": "apple", "самсунг": "samsung", "дайсон": "dyson", "ксбокс": "xbox",
    "икс-бокс": "xbox", "свитч": "switch", "нинтендо": "nintendo",
    "айпад": "ipad", "ipad": "ipad", "часы": "watch", "вотч": "watch",
    "джибиэль": "jbl", "колонка": "jbl", "леново": "lenovo", "асус": "asus",
}


def _alias(word: str) -> str:
    """Алиас с поддержкой префиксов: 'iph', 'айфо' -> iphone (для live-поиска по буквам)."""
    w = word.lower()
    if w in _SEARCH_ALIASES:
        return _SEARCH_ALIASES[w]
    for key, value in _SEARCH_ALIASES.items():
        if len(w) >= 3 and key.startswith(w):
            return value
    return word


def _photo_last(db: Session, products: list[Product]) -> list[Product]:
    """Стабильно переставить товары без реального фото (плейсхолдер/пусто) в
    конец списка — остальной порядок (уже заданный SQL ORDER BY) сохраняется."""
    resolved = resolve_product_images(db, products)
    return sorted(products, key=lambda p: 0 if has_real_photo(resolved.get(p.id)) else 1)


def search_products(db: Session, query: str, price_max: float | None = None, limit: int = 6) -> list[Product]:
    """Простой поиск по словам. Общая функция для /catalog/search и AI-fallback.

    Товары без реального фото уходят в конец выдачи, но не исчезают из поиска."""
    stmt = select(Product).where(Product.is_active.is_(True))
    words = [_alias(w) for w in query.split() if len(w) >= 2][:5]
    for word in words:
        like = f"%{word}%"
        stmt = stmt.where(or_(
            Product.title.ilike(like), Product.brand.ilike(like),
            Product.category.ilike(like), Product.subcategory.ilike(like),
            Product.sku.ilike(like),
            func.cast(Product.tags, Text).ilike(like),
        ))
    if price_max:
        stmt = stmt.where(Product.price <= price_max)
    stmt = stmt.order_by(Product.in_stock.desc(), Product.popularity.desc())
    products = list(db.execute(stmt).scalars().all())
    return _photo_last(db, products)[:limit]


@router.get("/search", dependencies=[Depends(get_current_user)])
def catalog_search(
    query: str = Query(min_length=1, max_length=200),
    price_max: float | None = Query(default=None, ge=0),
    limit: int = Query(default=6, ge=1, le=20),
    db: Session = Depends(get_db),
):
    products = search_products(db, query, price_max, limit)
    cards = [p.to_card() for p in products]
    apply_group_images(db, products, cards)
    return {"cards": cards}


# ==================== Демо: витрина каталога ====================

@router.get("/categories", dependencies=[Depends(get_current_user)])
def categories(db: Session = Depends(get_db)):
    """Категории для навигации — из самих товаров, а не из списка в коде.

    Пустых категорий здесь не бывает: раньше список был захардкожен, и плитки
    «Dyson»/«Аксессуары» вели в пустой каталог, потому что таких категорий в БД
    нет. Новая категория (импорт, правка в админке) появляется сама."""
    return {"categories": list_categories(db)}


@router.get("/list", dependencies=[Depends(get_current_user)])
def list_catalog(
    category: str | None = Query(default=None, max_length=100),
    brand: str | None = Query(default=None, max_length=100),
    price_min: float | None = Query(default=None, ge=0),
    price_max: float | None = Query(default=None, ge=0),
    query: str | None = Query(default=None, max_length=200),
    sort: str = Query(default="popularity"),
    in_stock: bool | None = Query(default=None),
    available_today: bool | None = Query(default=None),
    on_sale: bool | None = Query(default=None),
    condition: str | None = Query(default=None, max_length=20),
    collection: str | None = Query(default=None, max_length=20),
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    stmt = select(Product).where(Product.is_active.is_(True))
    if category == "__sale__":       # виртуальная категория «Скидки»
        stmt = stmt.where(Product.on_sale.is_(True))
    elif category:
        stmt = stmt.where(Product.category == category)
    # Именованные подборки для баннеров (action_type=collection)
    if collection == "hot":
        stmt = stmt.where(Product.is_hot.is_(True))
    elif collection == "today":
        stmt = stmt.where(Product.is_available_today.is_(True), Product.in_stock.is_(True))
    elif collection == "sale":
        stmt = stmt.where(Product.on_sale.is_(True))
    if in_stock:
        stmt = stmt.where(Product.in_stock.is_(True))
    if available_today:
        stmt = stmt.where(Product.is_available_today.is_(True))
    if on_sale:
        stmt = stmt.where(Product.on_sale.is_(True))
    if condition:
        stmt = stmt.where(Product.condition == condition)
    if brand:
        stmt = stmt.where(Product.brand == brand)
    if price_min is not None:
        stmt = stmt.where(Product.price >= price_min)
    if price_max is not None:
        stmt = stmt.where(Product.price <= price_max)
    if query:
        for word in [_alias(w) for w in query.split() if len(w) >= 2][:5]:
            like = f"%{word}%"
            stmt = stmt.where(or_(
                Product.title.ilike(like), Product.brand.ilike(like),
                Product.category.ilike(like), Product.sku.ilike(like),
                func.cast(Product.tags, Text).ilike(like),
            ))

    if sort == "price_asc":
        stmt = stmt.order_by(Product.price.asc())
    elif sort == "price_desc":
        stmt = stmt.order_by(Product.price.desc())
    elif sort == "rating":
        stmt = stmt.order_by(Product.rating.desc())
    elif sort == "hot":
        stmt = stmt.order_by(Product.is_hot.desc(), Product.popularity.desc())
    else:
        stmt = stmt.order_by(Product.in_stock.desc(), Product.popularity.desc())

    products = list(db.execute(stmt).scalars().all())
    # Товары без реального фото — в конец выдачи (не пропадают из каталога),
    # выбранная сортировка сохраняется внутри каждой из двух групп.
    products = _photo_last(db, products)[:limit]
    cards = [p.to_card() for p in products]
    apply_group_images(db, products, cards)
    apply_social_proof(db, products, cards)
    return {"cards": cards}


@router.get("/brands", dependencies=[Depends(get_current_user)])
def brands(db: Session = Depends(get_db)):
    rows = db.execute(
        select(Product.brand).where(Product.is_active.is_(True), Product.brand.is_not(None)).distinct()
    ).scalars().all()
    return {"brands": sorted(rows)}


@router.get("/feed", dependencies=[Depends(get_current_user)])
def feed(db: Session = Depends(get_db)):
    """Секции главного экрана: горячее, забрать сегодня, новинки, рекомендуем.

    v5.2.6: каждая секция дедуплицируется по группе модель+цвет (варианты одной
    модели, отличающиеся памятью, не превращаются в визуальные дубли — остаётся
    один representative), и «Рекомендуем» исключает уже показанные ГРУППЫ, а не
    только id. Фото проставляются из канонических групп одним батчем (без N+1).
    До 8 товаров в секции; при маленьком каталоге секция не остаётся пустой.

    v5.4.1: товары без реального фото (плейсхолдер/пустая галерея) на главную не
    попадают вовсе — исключаются из всех 4 секций до дедупа и добора.
    """
    def rows(stmt, n=32):
        return db.execute(stmt.limit(n)).scalars().all()

    base = select(Product).where(Product.is_active.is_(True))
    hot_raw = rows(base.where(Product.is_hot.is_(True)).order_by(Product.popularity.desc()))
    today_raw = rows(base.where(Product.is_available_today.is_(True), Product.in_stock.is_(True))
                     .order_by(Product.popularity.desc()))
    new_raw = rows(base.where(Product.is_new.is_(True)).order_by(Product.id.desc()))
    recent_raw = rows(base.order_by(Product.id.desc()), n=64)
    pool_raw = rows(base.order_by(Product.in_stock.desc(), Product.popularity.desc()), n=96)

    all_candidates = list({p.id: p for p in (*hot_raw, *today_raw, *new_raw, *recent_raw, *pool_raw)}.values())
    resolved = resolve_product_images(db, all_candidates)

    def with_photo(items):
        return [p for p in items if has_real_photo(resolved.get(p.id))]

    hot = dedupe_by_group(with_photo(hot_raw))[:8]
    today = dedupe_by_group(with_photo(today_raw))[:8]

    new_items = dedupe_by_group(with_photo(new_raw))
    if len(new_items) < 8:  # добираем недавними (id как надёжный прокси «добавлен позже»)
        seen_new = {p.id for p in new_items}
        for p in dedupe_by_group(with_photo(recent_raw)):
            if p.id not in seen_new:
                new_items.append(p)
                seen_new.add(p.id)
                if len(new_items) >= 8:
                    break
    new_items = new_items[:8]

    shown_ids = {p.id for p in (*hot, *today, *new_items)}
    shown_keys = {p.image_group_key for p in (*hot, *today, *new_items) if p.image_group_key}
    pool = dedupe_by_group(with_photo(pool_raw))
    recommended = [p for p in pool
                   if p.id not in shown_ids
                   and (not p.image_group_key or p.image_group_key not in shown_keys)][:8] or pool[:8]

    uniq = list({p.id: p for p in (*hot, *today, *new_items, *recommended)}.values())
    cards = {p.id: p.to_card() for p in uniq}
    apply_group_images(db, uniq, [cards[p.id] for p in uniq])

    def section(items):
        return [cards[p.id] for p in items]

    return {
        "hot": section(hot),
        "available_today": section(today),
        "new": section(new_items),
        "recommended": section(recommended),
    }


@router.get("/recommendations")
def recommendations(
    limit: int = Query(default=12, ge=1, le=24),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Персональные рекомендации «Для вас» (preview-формат). Учитывают просмотры/
    избранное/заявки пользователя; для нового пользователя — популярное+новинки из
    разных категорий. reason — enum-подсказка (без внутреннего скоринга наружу)."""
    products, reasons, mode = recommend(db, user.id, limit)
    cards = [p.to_card() for p in products]
    apply_group_images(db, products, cards)
    for c, p in zip(cards, products):
        c["reason"] = reasons.get(p.id)
    return {"cards": cards, "mode": mode}


@router.get("/recently-viewed")
def recently_viewed_endpoint(
    limit: int = Query(default=10, ge=1, le=20),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """«Вы недавно смотрели»: последние просмотренные активные товары (дедуп по
    товару, порядок последнего просмотра). Пусто -> секция не показывается."""
    products = recently_viewed(db, user.id, limit)
    cards = [p.to_card() for p in products]
    apply_group_images(db, products, cards)
    return {"cards": cards}


@router.get("/product/{product_id}", dependencies=[Depends(get_current_user)])
@router.get("/products/{product_id}", dependencies=[Depends(get_current_user)])  # alias (spec v2)
def product_details(product_id: int, db: Session = Depends(get_db)):
    product = db.get(Product, product_id)
    if product is None or not product.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    detail = product.to_detail()
    apply_group_images(db, [product], [detail])
    apply_social_proof(db, [product], [detail])
    return detail
