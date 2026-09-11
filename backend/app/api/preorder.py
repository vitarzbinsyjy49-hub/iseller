"""Экран события предзаказа: одна группа товаров + её баннер.

Отдельной таблицы событий нет намеренно. Событие полностью описывается двумя
вещами, которые уже существуют и уже редактируются в админке:

- **товарами** — все с одним `preorder_group`. Ровно та же линия, что у
  категорий в `services/catalog_nav`: список в коде разъезжается с базой, а
  данные — нет;
- **баннером**, который на это событие ведёт (`action_type="preorder"`,
  `action_value=<группа>`). Его `title`, `subtitle`, `image_url` и
  `background_gradient` и есть заголовок, вступление, афиша и палитра экрана.
  Завести под то же самое второй набор полей значило бы гарантировать, что
  однажды они разойдутся.

Пустая группа — это 200 с пустым списком, а не 404. Группа пустеет сама, когда
товары приехали и стали обычными: это штатный конец жизни события, а не ошибка,
и экран должен уметь сказать «всё приехало», а не падать.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.home import HomeBanner
from app.models.product import Product
from app.services.image_groups import apply_group_images

router = APIRouter(prefix="/preorder", tags=["preorder"])


@router.get("/{group}", dependencies=[Depends(get_current_user)])
def get_preorder_event(group: str, db: Session = Depends(get_db)):
    banner = db.execute(
        select(HomeBanner).where(
            HomeBanner.action_type == "preorder",
            HomeBanner.action_value == group,
        )
    ).scalars().first()

    # Порядок — по id, то есть по порядку заведения. Отдельной колонки под
    # позицию нет: переставлять пока нечего, а лишняя колонка, которую никто не
    # трогает, — это ещё одно место, где данные могут разойтись с показом.
    products = db.execute(
        select(Product)
        .where(
            Product.is_active.is_(True),
            Product.availability_mode == "preorder",
            Product.preorder_group == group,
        )
        .order_by(Product.id.asc())
    ).scalars().all()

    cards = [p.to_card() for p in products]
    apply_group_images(db, products, cards)

    return {
        "banner": banner.to_dict() if banner else None,
        "items": cards,
    }
