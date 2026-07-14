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
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.product import Product

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
    "ps5": "playstation", "пс5": "playstation", "плейстейшн": "playstation",
    "айфон": "iphone", "макбук": "macbook", "аирподс": "airpods",
    "эпл": "apple", "самсунг": "samsung", "дайсон": "dyson",
}


def search_products(db: Session, query: str, price_max: float | None = None, limit: int = 6) -> list[Product]:
    """Простой поиск по словам. Общая функция для /catalog/search и AI-fallback."""
    stmt = select(Product)
    words = [_SEARCH_ALIASES.get(w.lower(), w) for w in query.split() if len(w) >= 3][:5]
    for word in words:
        like = f"%{word}%"
        stmt = stmt.where(or_(Product.title.ilike(like), Product.brand.ilike(like), Product.category.ilike(like)))
    if price_max:
        stmt = stmt.where(Product.price <= price_max)
    stmt = stmt.order_by(Product.in_stock.desc(), Product.popularity.desc()).limit(limit)
    return list(db.execute(stmt).scalars().all())


@router.get("/search", dependencies=[Depends(get_current_user)])
def catalog_search(
    query: str = Query(min_length=1, max_length=200),
    price_max: float | None = Query(default=None, ge=0),
    limit: int = Query(default=6, ge=1, le=20),
    db: Session = Depends(get_db),
):
    products = search_products(db, query, price_max, limit)
    return {"cards": [p.to_card() for p in products]}


# ==================== Демо: витрина каталога ====================

# Фиксированный порядок категорий для Home (иконка + подпись)
CATEGORIES = [
    {"key": "смартфоны", "label": "Смартфоны", "icon": "📱"},
    {"key": "ноутбуки", "label": "Ноутбуки", "icon": "💻"},
    {"key": "планшеты", "label": "Планшеты", "icon": "📲"},
    {"key": "наушники", "label": "Наушники", "icon": "🎧"},
    {"key": "консоли", "label": "Консоли", "icon": "🎮"},
    {"key": "dyson", "label": "Dyson", "icon": "💨"},
    {"key": "аксессуары", "label": "Аксессуары", "icon": "🔌"},
    {"key": "__sale__", "label": "Скидки", "icon": "🏷️"},  # виртуальная: фильтр on_sale
]


@router.get("/categories", dependencies=[Depends(get_current_user)])
def categories(db: Session = Depends(get_db)):
    # Считаем товары в каждой категории (только активные)
    rows = db.execute(
        select(Product.category, func.count()).where(Product.is_active.is_(True)).group_by(Product.category)
    ).all()
    counts = {c: n for c, n in rows}
    sale_count = db.execute(
        select(func.count()).select_from(Product).where(Product.is_active.is_(True), Product.on_sale.is_(True))
    ).scalar_one()
    counts["__sale__"] = sale_count
    return {"categories": [{**c, "count": counts.get(c["key"], 0)} for c in CATEGORIES]}


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
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    stmt = select(Product).where(Product.is_active.is_(True))
    if category == "__sale__":       # виртуальная категория «Скидки»
        stmt = stmt.where(Product.on_sale.is_(True))
    elif category:
        stmt = stmt.where(Product.category == category)
    if in_stock:
        stmt = stmt.where(Product.in_stock.is_(True))
    if available_today:
        stmt = stmt.where(Product.is_available_today.is_(True))
    if on_sale:
        stmt = stmt.where(Product.on_sale.is_(True))
    if brand:
        stmt = stmt.where(Product.brand == brand)
    if price_min is not None:
        stmt = stmt.where(Product.price >= price_min)
    if price_max is not None:
        stmt = stmt.where(Product.price <= price_max)
    if query:
        like = f"%{_SEARCH_ALIASES.get(query.strip().lower(), query)}%"
        stmt = stmt.where(or_(Product.title.ilike(like), Product.brand.ilike(like)))

    if sort == "price_asc":
        stmt = stmt.order_by(Product.price.asc())
    elif sort == "price_desc":
        stmt = stmt.order_by(Product.price.desc())
    elif sort == "rating":
        stmt = stmt.order_by(Product.rating.desc())
    else:
        stmt = stmt.order_by(Product.in_stock.desc(), Product.popularity.desc())

    products = db.execute(stmt.limit(limit)).scalars().all()
    return {"cards": [p.to_card() for p in products]}


@router.get("/brands", dependencies=[Depends(get_current_user)])
def brands(db: Session = Depends(get_db)):
    rows = db.execute(
        select(Product.brand).where(Product.is_active.is_(True), Product.brand.is_not(None)).distinct()
    ).scalars().all()
    return {"brands": sorted(rows)}


@router.get("/feed", dependencies=[Depends(get_current_user)])
def feed(db: Session = Depends(get_db)):
    """Секции главного экрана: горячее, можно забрать сегодня, рекомендуем."""
    def section(stmt, n=8):
        return [p.to_card() for p in db.execute(stmt.limit(n)).scalars().all()]

    base = select(Product).where(Product.is_active.is_(True))
    hot = section(base.where(Product.is_hot.is_(True)).order_by(Product.popularity.desc()))
    today = section(base.where(Product.is_available_today.is_(True), Product.in_stock.is_(True))
                    .order_by(Product.popularity.desc()))
    recommended = section(base.order_by(Product.popularity.desc()))
    return {"hot": hot, "available_today": today, "recommended": recommended}


@router.get("/product/{product_id}", dependencies=[Depends(get_current_user)])
@router.get("/products/{product_id}", dependencies=[Depends(get_current_user)])  # alias (spec v2)
def product_details(product_id: int, db: Session = Depends(get_db)):
    product = db.get(Product, product_id)
    if product is None or not product.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    return product.to_detail()
