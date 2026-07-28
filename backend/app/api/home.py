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
from app.services.catalog_nav import (
    brand_counts, category_counts, has_products, list_brands, list_categories,
    sale_count,
)

router = APIRouter(prefix="/home", tags=["home"])
admin_router = APIRouter(
    prefix="/admin/home", tags=["admin-home"], dependencies=[Depends(get_current_admin)]
)


def _auto_tile(item: dict, *, action_type: str, index: int,
               id_offset: int, position_base: int) -> dict:
    """Плитка, которой админ ещё не занимался, — собирается из данных каталога.

    id отрицательный и разведён по осям смещением: он используется только как
    React-ключ на фронте и не должен совпадать у категории и бренда."""
    return {
        "id": -(id_offset + index + 1), "title": item["label"], "emoji": item["icon"],
        "icon_url": None, "background_gradient": None,
        "action_type": action_type, "action_value": item["key"],
        "position": position_base + index, "is_active": True,
    }


@router.get("", dependencies=[Depends(get_current_user)])
def get_home(db: Session = Depends(get_db)):
    banners = db.execute(
        select(HomeBanner).where(HomeBanner.is_active.is_(True)).order_by(HomeBanner.position, HomeBanner.id)
    ).scalars().all()
    # Берём и выключенные тоже: выключенная плитка — это осознанное «не
    # показывать», и автодобавление не должно её воскрешать.
    managed = db.execute(
        select(HomeCategory).order_by(HomeCategory.position, HomeCategory.id)
    ).scalars().all()

    # Счётчики — один раз на запрос, а не на плитку.
    cats, brands, sale = category_counts(db), brand_counts(db), sale_count(db)

    # 1) Плитка, за которой нет товаров, на главную не выходит: пустой экран
    #    после нажатия хуже отсутствующей плитки. Скрываем только посчитанное
    #    (категория/бренд) — поиск, подборки и AI не трогаем.
    def shown(rows: list[HomeCategory]) -> list[dict]:
        return [c.to_dict() for c in rows
                if c.is_active
                and has_products(c.action_type, c.action_value,
                                 categories=cats, brands=brands, sale=sale)]

    # 2) Две оси навигации: бренды отдельной вкладкой, всё остальное — включая
    #    непосчитаемые промо-плитки (поиск, подборка, AI) — на оси категорий.
    #    Третьей корзины нет намеренно: промо некуда переезжать.
    managed_brands = [c for c in managed if c.action_type == "brand"]
    managed_rest = [c for c in managed if c.action_type != "brand"]

    # 3) Категория, которой админ ещё не занимался, показывается сама. Так новый
    #    раздел (импорт прайса, товар из админки) появляется в навигации без
    #    правок кода и без ручного создания плитки. С брендами — то же правило.
    curated_cats = {(c.action_value or "").strip() for c in managed if c.action_type == "category"}
    categories = shown(managed_rest) + [
        _auto_tile(c, action_type="category", index=i, id_offset=0, position_base=1000)
        for i, c in enumerate(c for c in list_categories(db) if c["key"] not in curated_cats)
    ]

    curated_brands = {(c.action_value or "").strip() for c in managed_brands}
    brand_tiles = shown(managed_brands) + [
        _auto_tile(b, action_type="brand", index=i, id_offset=1000, position_base=2000)
        for i, b in enumerate(b for b in list_brands(db) if b["key"] not in curated_brands)
    ]

    return {
        "banners": [b.to_dict() for b in banners],
        "categories": categories,
        "brands": brand_tiles,
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

_TILE_TINTS = ["#e3f2fd", "#efe9fb", "#e0f4f3", "#fff3d6", "#ffe9ec",
               "#eaf7ea", "#f1f5f9", "#fde8e8"]


def default_categories(db: Session) -> list[dict]:
    """Стартовые плитки — из реального каталога, а не из списка в коде.

    Раньше здесь был захардкожен список, и он же засеял прод плитками «Dyson» и
    «Аксессуары», которых в каталоге нет: пользователь жал и попадал в пустоту.
    Теперь сид повторяет то, что реально лежит в БД; пустой каталог => плиток
    нет, они появятся при следующем старте после наполнения."""
    return [
        dict(title=c["label"], emoji=c["icon"],
             background_gradient=_TILE_TINTS[i % len(_TILE_TINTS)],
             action_type="category", action_value=c["key"], position=i + 1)
        for i, c in enumerate(list_categories(db))
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
        # Пустой каталог => плиток не создаём: пересоздадутся при следующем
        # старте, когда товары появятся. Пустая плитка хуже её отсутствия.
        for c in default_categories(db):
            db.add(HomeCategory(**c))
            seeded = True
    if seeded:
        db.commit()
    return seeded
