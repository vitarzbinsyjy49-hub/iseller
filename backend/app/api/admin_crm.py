"""Админ-часть демо: заявки, дашборд, аналитика, AI-логи, товары.

Всё под get_current_admin (та же JWT-цепочка Sprint 1, admin:{email}).
Отдельный роутер, чтобы не трогать рабочий admin.py (stats/audit).
"""
import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import client_ip, get_current_admin
from app.core.uploads import MAX_BYTES, delete_image, is_allowed, save_image
from app.db.session import get_db
from app.models.analytics_event import AnalyticsEvent
from app.models.audit import AuditLog
from app.models.lead import LEAD_STATUSES, Lead
from app.models.product import Product
from app.models.user import User
from app.schemas.ai import LeadStatusIn

router = APIRouter(prefix="/admin", tags=["admin-crm"], dependencies=[Depends(get_current_admin)])


# ==================== Leads ====================
@router.get("/leads")
def list_leads(
    db: Session = Depends(get_db),
    status_filter: str | None = None,
    source_filter: str | None = None,
    limit: int = 100,
):
    limit = min(limit, 500)
    stmt = select(Lead).order_by(Lead.id.desc())
    if status_filter:
        stmt = stmt.where(Lead.status == status_filter)
    if source_filter:
        stmt = stmt.where(Lead.source == source_filter)
    rows = db.execute(stmt.limit(limit)).scalars().all()
    return {"leads": [l.to_dict() for l in rows]}


@router.patch("/leads/{lead_id}")
def update_lead(lead_id: int, body: LeadStatusIn, db: Session = Depends(get_db)):
    lead = db.get(Lead, lead_id)
    if lead is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lead not found")
    if body.status is not None:
        if body.status not in LEAD_STATUSES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"status must be one of {LEAD_STATUSES}")
        lead.status = body.status
    if body.assigned_to is not None:
        lead.assigned_to = body.assigned_to
    if body.manager_comment is not None:
        lead.manager_comment = body.manager_comment
    db.commit()
    db.refresh(lead)
    return lead.to_dict()


# ==================== Dashboard ====================
@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db)):
    today = datetime.utcnow().date()
    day_start = datetime(today.year, today.month, today.day)

    users_total = db.execute(select(func.count()).select_from(User)).scalar_one()
    leads_total = db.execute(select(func.count()).select_from(Lead)).scalar_one()
    leads_today = db.execute(
        select(func.count()).select_from(Lead).where(Lead.created_at >= day_start)
    ).scalar_one()
    ai_queries = db.execute(
        select(func.count()).select_from(AnalyticsEvent).where(AnalyticsEvent.event == "ai_query_submitted")
    ).scalar_one()
    products_in_stock = db.execute(
        select(func.count()).select_from(Product).where(Product.is_active.is_(True), Product.in_stock.is_(True))
    ).scalar_one()
    recent_leads = db.execute(select(Lead).order_by(Lead.id.desc()).limit(8)).scalars().all()
    app_opens = db.execute(
        select(func.count()).select_from(AnalyticsEvent).where(AnalyticsEvent.event == "app_opened")
    ).scalar_one()

    # Конверсия «открытие AI-запроса -> заявка» (грубая, для демо)
    conversion = round((leads_total / ai_queries) * 100, 1) if ai_queries else 0.0

    # Популярные товары по событиям product_viewed
    viewed = db.execute(
        select(AnalyticsEvent.payload).where(AnalyticsEvent.event == "product_viewed").limit(1000)
    ).scalars().all()
    counter: dict[int, int] = {}
    for p in viewed:
        pid = (p or {}).get("product_id")
        if pid:
            counter[pid] = counter.get(pid, 0) + 1
    top_ids = sorted(counter, key=counter.get, reverse=True)[:5]
    top_products = []
    for pid in top_ids:
        prod = db.get(Product, pid)
        if prod:
            top_products.append({"id": pid, "title": prod.title, "views": counter[pid]})

    recent_events = db.execute(
        select(AnalyticsEvent).order_by(AnalyticsEvent.id.desc()).limit(15)
    ).scalars().all()

    return {
        "users_total": users_total,
        "leads_total": leads_total,
        "leads_today": leads_today,
        "ai_queries": ai_queries,
        "app_opens": app_opens,
        "conversion_pct": conversion,
        "products_in_stock": products_in_stock,
        "recent_leads": [l.to_dict() for l in recent_leads],
        "top_products": top_products,
        "recent_events": [
            {"event": e.event, "payload": e.payload, "created_at": e.created_at.isoformat()}
            for e in recent_events
        ],
    }


# ==================== Analytics ====================
@router.get("/analytics")
def analytics(db: Session = Depends(get_db)):
    # Счётчики по типам событий
    rows = db.execute(
        select(AnalyticsEvent.event, func.count()).group_by(AnalyticsEvent.event)
    ).all()
    by_event = {ev: cnt for ev, cnt in rows}

    # Воронка demo: app_opened -> product_viewed -> ai_query_submitted -> lead_created
    funnel = [
        {"step": "Открыли приложение", "event": "app_opened", "count": by_event.get("app_opened", 0)},
        {"step": "Открыли каталог", "event": "catalog_opened", "count": by_event.get("catalog_opened", 0)},
        {"step": "Смотрели товар", "event": "product_viewed", "count": by_event.get("product_viewed", 0)},
        {"step": "AI-запрос", "event": "ai_query_submitted", "count": by_event.get("ai_query_submitted", 0)},
        {"step": "Оставили заявку", "event": "lead_created", "count": by_event.get("lead_created", 0)},
    ]

    # Источники заявок
    src_rows = db.execute(select(Lead.source, func.count()).group_by(Lead.source)).all()
    sources = [{"source": s or "other", "count": c} for s, c in src_rows]

    return {"by_event": by_event, "funnel": funnel, "lead_sources": sources}


# ==================== AI logs ====================
@router.get("/ai-logs")
def ai_logs(db: Session = Depends(get_db), limit: int = 100):
    """Логи AI-ответов на основе событий ai_response_received."""
    limit = min(limit, 500)
    rows = db.execute(
        select(AnalyticsEvent).where(AnalyticsEvent.event == "ai_response_received")
        .order_by(AnalyticsEvent.id.desc()).limit(limit)
    ).scalars().all()
    return {"logs": [
        {"user_id": r.user_id, "payload": r.payload, "created_at": r.created_at.isoformat()}
        for r in rows
    ]}


# ==================== Products management ====================
@router.get("/products")
def admin_products(
    db: Session = Depends(get_db),
    q: str | None = None,
    category: str | None = None,
    brand: str | None = None,
    page: int = 1,
    page_size: int = 50,
    limit: int | None = None,   # legacy alias -> page_size
):
    """Список товаров с поиском (название + SKU), фильтрами и пагинацией.

    Поиск по q ведётся в Python (Unicode-регистронезависимо) — sqlite/PG
    ведут себя одинаково для кириллицы. category/brand — точное совпадение.
    Возвращает страницу + total/pages и полный список категорий/брендов
    (facets), чтобы фильтры в админке были полными вне текущей страницы.
    """
    if limit is not None:
        page_size = limit
    page = max(1, page)
    page_size = max(1, min(page_size, 500))

    stmt = select(Product).order_by(Product.id)
    if category:
        stmt = stmt.where(Product.category == category)
    if brand:
        stmt = stmt.where(Product.brand == brand)
    rows = db.execute(stmt).scalars().all()

    if q and q.strip():
        needle = q.strip().lower()
        rows = [
            p for p in rows
            if needle in (p.title or "").lower() or needle in (p.sku or "").lower()
        ]

    total = len(rows)
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]

    cats = db.execute(
        select(Product.category).where(Product.category.is_not(None)).distinct()
    ).scalars().all()
    brands = db.execute(
        select(Product.brand).where(Product.brand.is_not(None)).distinct()
    ).scalars().all()

    return {
        "products": [p.to_admin() for p in page_rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": (total + page_size - 1) // page_size if total else 0,
        "categories": sorted(cats),
        "brands": sorted(brands),
    }


# Поля товара, которые можно править/задавать из админки (демо)
_PRODUCT_EDITABLE = (
    "sku", "title", "brand", "category", "subcategory", "price", "old_price", "stock", "in_stock",
    "is_active", "is_hot", "is_available_today", "is_new", "on_sale",
    "warranty_months", "condition", "color", "memory", "storage", "screen_size", "cpu", "ram",
    "description", "specs", "tags", "image", "images", "url",
    "rating", "popularity", "margin_pct",
    "model_family", "image_group_detached",   # v5.2.6: канонические группы фото
)


def _apply_product_fields(product: Product, body: dict) -> None:
    # SKU всегда канонизируем: верхний регистр, без пробелов (ключ импорта/фото)
    if body.get("sku"):
        body = {**body, "sku": str(body["sku"]).strip().upper() or None}
    for field in _PRODUCT_EDITABLE:
        if field in body:
            setattr(product, field, body[field])
    # in_stock авто-согласуем со stock, если пришёл только stock
    if "stock" in body and "in_stock" not in body:
        product.in_stock = int(body["stock"] or 0) > 0


@router.post("/products", status_code=status.HTTP_201_CREATED)
def admin_create_product(body: dict, db: Session = Depends(get_db)):
    title = (body.get("title") or "").strip()
    if not title or body.get("price") is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title and price are required")
    product = Product(title=title, price=body["price"])
    _apply_product_fields(product, body)
    db.add(product)
    db.commit()
    db.refresh(product)
    return product.to_admin()


@router.patch("/products/{product_id}")
def admin_update_product(product_id: int, body: dict, db: Session = Depends(get_db)):
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    _apply_product_fields(product, body)
    db.commit()
    db.refresh(product)
    return product.to_admin()


@router.patch("/products/{product_id}/stock")
def admin_update_stock(product_id: int, body: dict, db: Session = Depends(get_db)):
    """Быстрое обновление наличия: {"stock": 5} и/или {"in_stock": true}."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    if "stock" in body:
        try:
            product.stock = max(0, int(body["stock"]))
        except (TypeError, ValueError):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "stock must be an integer")
        if "in_stock" not in body:
            product.in_stock = product.stock > 0
    if "in_stock" in body:
        product.in_stock = bool(body["in_stock"])
    db.commit()
    db.refresh(product)
    return product.to_admin()


@router.get("/products/{product_id}/image-group")
def admin_product_image_group(product_id: int, db: Session = Depends(get_db)):
    """v5.2.6: инфо о канонической группе фото товара для админки — сколько
    вариантов (модель+цвет) затрагивает общая галерея, какие это варианты,
    картинки группы и эффективная галерея (что реально покажется на витрине)."""
    from app.models.product_image_group import ProductImageGroup
    from app.services.image_groups import resolve_product_images
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    key = product.image_group_key
    variants, group = [], None
    if key:
        variants = db.execute(
            select(Product).where(Product.image_group_key == key).order_by(Product.price.asc())
        ).scalars().all()
        group = db.execute(
            select(ProductImageGroup).where(ProductImageGroup.key == key)
        ).scalar_one_or_none()
    effective = resolve_product_images(db, [product]).get(product.id, {"image": None, "images": []})
    return {
        "product_id": product.id,
        "image_group_key": key,
        "model_family": product.model_family,
        "detached": bool(product.image_group_detached),
        "brand": product.brand,
        "color": product.color,
        "variant_count": len(variants),
        "variants": [
            {"id": p.id, "sku": p.sku, "title": p.title, "in_stock": p.in_stock, "price": float(p.price)}
            for p in variants[:50]
        ],
        "group_images": (group.images if group else []) or [],
        "group_primary": group.image if group else None,
        "effective_images": effective["images"],
    }


# ==================== Массовые действия и безопасное удаление ====================
_BULK_ACTIONS = ("activate", "deactivate", "set_out_of_stock", "delete")
_BLOCKED_MESSAGE = "Товар используется в заявках или постах. Его можно только скрыть"


def product_delete_blockers(db: Session, product_id: int) -> dict:
    """Связи, при которых товар нельзя удалять физически.

    Жёсткий блокер — только заявки (Lead.product_id): это реальные записи CRM.
    Посты (ChannelPost) не ссылаются на товар в схеме БД. Аналитика —
    append-only лог событий (product_id лежит внутри JSON payload) и удалению
    товара не мешает, иначе почти каждый просмотренный демо-товар стал бы
    неудаляемым, что противоречит задаче «чистить демо-каталог».
    """
    leads = db.execute(
        select(func.count()).select_from(Lead).where(Lead.product_id == product_id)
    ).scalar_one()
    blockers: dict = {}
    if leads:
        blockers["leads"] = leads
    return blockers


@router.delete("/products/{product_id}")
def admin_delete_product(
    product_id: int,
    request: Request,
    admin: str = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Физическое удаление товара. Только для администратора (роутер под
    get_current_admin). Если товар используется в заявках — 409, не удаляем."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")

    blockers = product_delete_blockers(db, product_id)
    if blockers:
        raise HTTPException(status.HTTP_409_CONFLICT, _BLOCKED_MESSAGE)

    sku, title = product.sku, product.title
    db.delete(product)
    db.add(AuditLog(
        actor=f"admin:{admin}", action="product_deleted", ip=client_ip(request),
        detail=json.dumps({"product_id": product_id, "sku": sku, "title": title}, ensure_ascii=False),
    ))
    db.commit()
    return {"ok": True, "id": product_id, "deleted": True}


@router.post("/products/bulk-action")
def admin_bulk_action(
    body: dict,
    request: Request,
    admin: str = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Массовое действие над выбранными товарами (одной транзакцией).

    body = {"product_ids": [1,2,3], "action": "deactivate"}
    action ∈ activate | deactivate | set_out_of_stock | delete.

    Для delete товары со связанными заявками не удаляются физически, а
    скрываются (is_active=false) и попадают в счётчик hidden. Несуществующие
    id — в skipped. Любая непредвиденная ошибка откатывает всю транзакцию.
    """
    action = (body or {}).get("action")
    raw_ids = (body or {}).get("product_ids")
    if action not in _BULK_ACTIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"action must be one of {_BULK_ACTIONS}")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "product_ids must be a non-empty list")
    try:
        ids = list(dict.fromkeys(int(x) for x in raw_ids))  # дедуп с сохранением порядка
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "product_ids must be integers")
    if len(ids) > 1000:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Не больше 1000 товаров за одну операцию")

    deleted = hidden = updated = 0
    skipped_details: list[dict] = []
    try:
        for pid in ids:
            product = db.get(Product, pid)
            if product is None:
                skipped_details.append({"id": pid, "reason": "не найден"})
                continue
            if action == "activate":
                product.is_active = True
                updated += 1
            elif action == "deactivate":
                product.is_active = False
                updated += 1
            elif action == "set_out_of_stock":
                product.stock = 0
                product.in_stock = False
                product.is_available_today = False
                updated += 1
            elif action == "delete":
                if product_delete_blockers(db, pid):
                    product.is_active = False   # используется в заявках — скрываем, не удаляем
                    hidden += 1
                else:
                    db.delete(product)
                    deleted += 1

        skipped = len(skipped_details)
        db.add(AuditLog(
            actor=f"admin:{admin}", action=f"products_bulk_{action}", ip=client_ip(request),
            detail=json.dumps({
                "action": action, "product_ids": ids,
                "deleted": deleted, "hidden": hidden, "updated": updated,
                "skipped": skipped, "skipped_details": skipped_details,
            }, ensure_ascii=False),
        ))
        db.commit()
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 — атомарность: либо весь пакет, либо ничего
        db.rollback()
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Массовая операция не выполнена, изменения откачены",
        )

    return {
        "action": action,
        "requested": len(ids),
        "deleted": deleted,
        "hidden": hidden,
        "updated": updated,
        "skipped": len(skipped_details),
        "skipped_details": skipped_details,
        "processed": deleted + hidden + updated,
    }


# ==================== Product images (галерея) ====================
@router.post("/products/{product_id}/images", status_code=status.HTTP_201_CREATED)
async def admin_add_product_image(
    product_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)
):
    """Загрузить фото к товару. Первое загруженное фото автоматически становится главным."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    if not is_allowed(file.content_type):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Только изображения: jpg, png, webp, gif")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    url = save_image(file.content_type, data)
    product.images = list(product.images or []) + [url]
    # первая реальная картинка становится главной: если главной ещё нет
    # или там демо-заглушка из сида (/assets/placeholders/...)
    if not product.image or product.image.startswith("/assets/placeholders/"):
        product.image = url
    db.commit()
    db.refresh(product)
    return product.to_admin()


@router.post("/products/{product_id}/images/main")
def admin_set_main_image(product_id: int, body: dict = Body(...), db: Session = Depends(get_db)):
    """Сделать одну из загруженных картинок главной."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    url = (body or {}).get("url")
    if not url or url not in (product.images or []):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "url должен быть одной из загруженных картинок")
    product.image = url
    db.commit()
    db.refresh(product)
    return product.to_admin()


@router.delete("/products/{product_id}/images")
def admin_delete_product_image(product_id: int, body: dict = Body(...), db: Session = Depends(get_db)):
    """Удалить фото товара. Если удалили главную — главной становится первая оставшаяся."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    url = (body or {}).get("url")
    images = list(product.images or [])
    if url in images:
        images.remove(url)
        product.images = images
        delete_image(url)
        if product.image == url:
            product.image = images[0] if images else None
        db.commit()
        db.refresh(product)
    return product.to_admin()


@router.post("/products/import")
def admin_import_products(body: list[dict] | dict, db: Session = Depends(get_db)):
    """MVP-импорт каталога: JSON array товаров.

    Матчинг: по sku (если есть в specs/на верхнем уровне) или по точному title.
    Совпал — обновляем, нет — создаём. Старые товары НЕ удаляются.
    Возвращает отчёт {created, updated, skipped, errors[]}.
    """
    items = body if isinstance(body, list) else body.get("items")
    if not isinstance(items, list):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ожидается JSON array товаров (или {\"items\": [...]})")
    if len(items) > 500:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Не больше 500 товаров за один импорт")

    created = updated = skipped = 0
    errors: list[dict] = []

    for i, raw in enumerate(items):
        if not isinstance(raw, dict):
            skipped += 1
            errors.append({"index": i, "error": "элемент не является объектом"})
            continue
        title = (raw.get("title") or "").strip()
        sku = str(raw.get("sku") or "").strip()
        if not title and not sku:
            skipped += 1
            errors.append({"index": i, "error": "нет title и sku"})
            continue
        try:
            product = None
            if sku:
                product = db.execute(
                    select(Product).where(func.lower(Product.sku) == sku.lower())
                ).scalars().first()
            if product is None and title:
                product = db.execute(
                    select(Product).where(func.lower(Product.title) == title.lower())
                ).scalar_one_or_none()

            payload = dict(raw)
            payload.pop("id", None)

            if product is None:
                if not title or payload.get("price") is None:
                    skipped += 1
                    errors.append({"index": i, "error": "для нового товара нужны title и price"})
                    continue
                product = Product(title=title, price=payload["price"])
                _apply_product_fields(product, payload)
                if "is_active" not in payload:
                    product.is_active = True
                db.add(product)
                created += 1
            else:
                _apply_product_fields(product, payload)
                updated += 1
            db.commit()
        except Exception as e:  # noqa: BLE001 — отчёт вместо 500 на кривой строке
            db.rollback()
            skipped += 1
            errors.append({"index": i, "title": title, "error": str(e)[:200]})

    return {"created": created, "updated": updated, "skipped": skipped, "errors": errors}
