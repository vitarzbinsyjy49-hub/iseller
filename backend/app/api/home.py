"""Главная витрины (v4): публичная выдача + админ-CRUD баннеров и категорий.

GET /api/home — всё для отрисовки главной одним запросом: активные баннеры и
кнопки категорий в порядке position. Товарные секции фронт по-прежнему берёт
из /catalog/feed (кэш и логика не меняются).
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.models.home import ACTION_TYPES, HomeBanner, HomeCategory

router = APIRouter(prefix="/home", tags=["home"])
admin_router = APIRouter(
    prefix="/admin/home", tags=["admin-home"], dependencies=[Depends(get_current_admin)]
)


@router.get("", dependencies=[Depends(get_current_user)])
def get_home(db: Session = Depends(get_db)):
    banners = db.execute(
        select(HomeBanner).where(HomeBanner.is_active.is_(True)).order_by(HomeBanner.position, HomeBanner.id)
    ).scalars().all()
    categories = db.execute(
        select(HomeCategory).where(HomeCategory.is_active.is_(True)).order_by(HomeCategory.position, HomeCategory.id)
    ).scalars().all()
    return {
        "banners": [b.to_dict() for b in banners],
        "categories": [c.to_dict() for c in categories],
    }


# ==================== Admin CRUD ====================

_BANNER_FIELDS = ("title", "subtitle", "emoji", "image_url", "background_gradient",
                  "action_type", "action_value", "position", "is_active")
_CATEGORY_FIELDS = ("title", "emoji", "icon_url", "background_gradient",
                    "action_type", "action_value", "position", "is_active")


def _apply(obj, body: dict, fields: tuple) -> None:
    if body.get("action_type") is not None and body["action_type"] not in ACTION_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"action_type must be one of {ACTION_TYPES}")
    for f in fields:
        if f in body:
            setattr(obj, f, body[f])


@admin_router.get("/banners")
def admin_list_banners(db: Session = Depends(get_db)):
    rows = db.execute(select(HomeBanner).order_by(HomeBanner.position, HomeBanner.id)).scalars().all()
    return {"banners": [b.to_dict() for b in rows]}


@admin_router.post("/banners", status_code=status.HTTP_201_CREATED)
def admin_create_banner(body: dict, db: Session = Depends(get_db)):
    if not (body.get("title") or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title is required")
    banner = HomeBanner(title=body["title"].strip())
    _apply(banner, body, _BANNER_FIELDS)
    db.add(banner)
    db.commit()
    db.refresh(banner)
    return banner.to_dict()


@admin_router.patch("/banners/{banner_id}")
def admin_update_banner(banner_id: int, body: dict, db: Session = Depends(get_db)):
    banner = db.get(HomeBanner, banner_id)
    if banner is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Banner not found")
    _apply(banner, body, _BANNER_FIELDS)
    db.commit()
    db.refresh(banner)
    return banner.to_dict()


@admin_router.delete("/banners/{banner_id}")
def admin_delete_banner(banner_id: int, db: Session = Depends(get_db)):
    banner = db.get(HomeBanner, banner_id)
    if banner is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Banner not found")
    db.delete(banner)
    db.commit()
    return {"ok": True, "id": banner_id}


@admin_router.get("/categories")
def admin_list_categories(db: Session = Depends(get_db)):
    rows = db.execute(select(HomeCategory).order_by(HomeCategory.position, HomeCategory.id)).scalars().all()
    return {"categories": [c.to_dict() for c in rows]}


@admin_router.post("/categories", status_code=status.HTTP_201_CREATED)
def admin_create_category(body: dict, db: Session = Depends(get_db)):
    if not (body.get("title") or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title is required")
    cat = HomeCategory(title=body["title"].strip())
    _apply(cat, body, _CATEGORY_FIELDS)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat.to_dict()


@admin_router.patch("/categories/{category_id}")
def admin_update_category(category_id: int, body: dict, db: Session = Depends(get_db)):
    cat = db.get(HomeCategory, category_id)
    if cat is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found")
    _apply(cat, body, _CATEGORY_FIELDS)
    db.commit()
    db.refresh(cat)
    return cat.to_dict()


@admin_router.delete("/categories/{category_id}")
def admin_delete_category(category_id: int, db: Session = Depends(get_db)):
    cat = db.get(HomeCategory, category_id)
    if cat is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found")
    db.delete(cat)
    db.commit()
    return {"ok": True, "id": category_id}


# ==================== Seed по умолчанию ====================

DEFAULT_BANNERS = [
    dict(title="iPhone в наличии", subtitle="Забирайте сегодня на Горбушке", emoji="📱",
         background_gradient="linear-gradient(135deg,#1a7fd4,#6d5ae0)", action_type="search",
         action_value="iphone", position=1),
    dict(title="MacBook для работы", subtitle="Подборка под ваши задачи", emoji="💻",
         background_gradient="linear-gradient(135deg,#434371,#232350)", action_type="ai",
         action_value="MacBook для работы", position=2),
    dict(title="PlayStation сегодня", subtitle="PS5 и игры в наличии", emoji="🎮",
         background_gradient="linear-gradient(135deg,#0f3ba8,#0a6ed1)", action_type="search",
         action_value="playstation", position=3),
    dict(title="Подберём лучшую цену", subtitle="AI-консультант найдёт вариант", emoji="🤖",
         background_gradient="linear-gradient(135deg,#0e9f6e,#0694a2)", action_type="ai",
         action_value="", position=4),
    dict(title="Техника с гарантией", subtitle="Официальная гарантия до 24 мес", emoji="🛡️",
         background_gradient="linear-gradient(135deg,#d97706,#db2777)", action_type="collection",
         action_value="hot", position=5),
]

DEFAULT_CATEGORIES = [
    dict(title="Смартфоны", emoji="📱", background_gradient="#e3f2fd", action_type="category", action_value="смартфоны", position=1),
    dict(title="Ноутбуки", emoji="💻", background_gradient="#efe9fb", action_type="category", action_value="ноутбуки", position=2),
    dict(title="Планшеты", emoji="📲", background_gradient="#e0f4f3", action_type="category", action_value="планшеты", position=3),
    dict(title="Наушники", emoji="🎧", background_gradient="#fff3d6", action_type="category", action_value="наушники", position=4),
    dict(title="Консоли", emoji="🎮", background_gradient="#ffe9ec", action_type="category", action_value="консоли", position=5),
    dict(title="Dyson", emoji="💨", background_gradient="#eaf7ea", action_type="category", action_value="dyson", position=6),
    dict(title="Аксессуары", emoji="🔌", background_gradient="#f1f5f9", action_type="category", action_value="аксессуары", position=7),
    dict(title="Скидки", emoji="🏷️", background_gradient="#fde8e8", action_type="category", action_value="__sale__", position=8),
]


def seed_home_defaults(db: Session) -> bool:
    """Наполняет главную стартовыми баннерами/категориями, если таблицы пустые.
    Вызывается на старте приложения — живой сервер получит баннеры после деплоя
    без ручных действий. Ничего не трогает, если админ уже что-то создал."""
    seeded = False
    if db.execute(select(HomeBanner).limit(1)).scalar_one_or_none() is None:
        for b in DEFAULT_BANNERS:
            db.add(HomeBanner(**b))
        seeded = True
    if db.execute(select(HomeCategory).limit(1)).scalar_one_or_none() is None:
        for c in DEFAULT_CATEGORIES:
            db.add(HomeCategory(**c))
        seeded = True
    if seeded:
        db.commit()
    return seeded
