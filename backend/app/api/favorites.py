"""Избранное пользователя (серверное хранение).

Все эндпоинты под get_current_user — пользователь работает ТОЛЬКО со своим
избранным (фильтр по user.id в каждом запросе). Идемпотентность: повторное
добавление/удаление не ошибка.

GET    /api/favorites/ids           — id избранных товаров (состояние сердечек)
GET    /api/favorites               — карточки избранных активных товаров (экран)
PUT    /api/favorites/{product_id}  — добавить (идемпотентно), 404 если товара нет
DELETE /api/favorites/{product_id}  — удалить (идемпотентно)
POST   /api/favorites/merge         — слить локальное избранное (гость) с серверным
"""
import logging

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.favorite import ProductFavorite
from app.models.product import Product
from app.models.user import User
from app.services.recommendations import record_event

logger = logging.getLogger("techshop.favorites")
router = APIRouter(prefix="/favorites", tags=["favorites"])

MAX_MERGE_IDS = 500


def _baseline(product: Product) -> dict:
    """Отметки «что человек уже видел» на момент добавления в избранное.

    Ставятся СРАЗУ, а не первым сканом: иначе товар, добавленный между сканами,
    попадёт в скан как новая строка и получит статус «первое знакомство» — то
    есть отметку с ценой на момент СКАНА. Снижение, случившееся в этом
    промежутке, было бы потеряно молча.
    """
    from app.services.favorite_watch import in_stock_now

    return {"notified_price": float(product.price), "notified_in_stock": in_stock_now(product)}


def _favorite_ids(db: Session, user_id: int) -> list[int]:
    return list(
        db.execute(
            select(ProductFavorite.product_id).where(ProductFavorite.user_id == user_id)
        ).scalars().all()
    )


@router.get("/ids")
def favorite_ids(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Все id избранного пользователя — один запрос для состояния сердечек
    (без отдельного запроса на каждую карточку)."""
    return {"ids": _favorite_ids(db, user.id)}


@router.get("")
def favorites_list(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Карточки избранного: только существующие активные товары, недавно
    добавленные — первыми. Нет в наличии НЕ прячем (временно закончился);
    скрытые/удалённые админом товары как рабочие карточки не показываем
    (is_active фильтр + каскад при удалении)."""
    rows = db.execute(
        select(Product)
        .join(ProductFavorite, ProductFavorite.product_id == Product.id)
        .where(ProductFavorite.user_id == user.id, Product.is_active.is_(True))
        .order_by(ProductFavorite.id.desc())
    ).scalars().all()
    return {"cards": [p.to_card() for p in rows]}


@router.put("/{product_id}", status_code=status.HTTP_200_OK)
def add_favorite(
    product_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    exists = db.execute(
        select(ProductFavorite.id).where(
            ProductFavorite.user_id == user.id, ProductFavorite.product_id == product_id
        )
    ).scalar_one_or_none()
    if exists is None:
        db.add(ProductFavorite(user_id=user.id, product_id=product_id, **_baseline(product)))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()  # параллельно уже добавили — идемпотентно ок
        # сильный сигнал для рекомендаций (серверная сторона, доверенная)
        record_event(db, user.id, "favorite_add", product_id=product_id,
                     category=product.category, source="favorite")
    return {"ok": True, "product_id": product_id, "favorited": True}


@router.delete("/{product_id}")
def remove_favorite(
    product_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    db.execute(
        delete(ProductFavorite).where(
            ProductFavorite.user_id == user.id, ProductFavorite.product_id == product_id
        )
    )
    db.commit()
    record_event(db, user.id, "favorite_remove", product_id=product_id, source="favorite")
    return {"ok": True, "product_id": product_id, "favorited": False}


@router.post("/merge")
def merge_favorites(
    body: dict = Body(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Слить локальное избранное (гостевой режим/localStorage) с серверным при
    входе. Пустой локальный список НЕ затирает серверное избранное — добавляем
    только недостающие и только реально существующие товары. Возвращает
    итоговый серверный список id."""
    raw = (body or {}).get("ids")
    ids: list[int] = []
    if isinstance(raw, list):
        for x in raw[:MAX_MERGE_IDS]:
            try:
                ids.append(int(x))
            except (TypeError, ValueError):
                continue
    if ids:
        existing = set(_favorite_ids(db, user.id))
        # Товары целиком, а не только id: слитой строке нужна та же отметка
        # состояния, что и добавленной вручную (см. _baseline).
        valid = db.execute(
            select(Product).where(Product.id.in_(set(ids)))
        ).scalars().all()
        added = False
        for product in valid:
            if product.id not in existing:
                db.add(ProductFavorite(user_id=user.id, product_id=product.id,
                                       **_baseline(product)))
                added = True
        if added:
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
    return {"ids": _favorite_ids(db, user.id)}
