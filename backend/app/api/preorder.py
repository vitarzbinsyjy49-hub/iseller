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

**Приехавшие аппараты** (`arrived`). Карточка предзаказа несёт описание и
характеристики, которых у складских вариантов нет, поэтому, когда аппарат
приехал, она не исчезает с экрана, а переходит в блок «Уже в наличии» и
показывает самый доступный реальный вариант. Варианты находятся по артикулу:
`PREORDER-IP18PRO` -> `IP-18PRO-…` (так их называет import_bsa). Приехавшим
считается аппарат, у которого есть хоть один вариант в наличии, — независимо
от того, сняли ли уже карточку предзаказа с витрины.

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
from app.services.price_posts import model_key

#: Артикул карточки предзаказа -> префикс артикулов её складских вариантов.
PREORDER_SKU_PREFIX = "PREORDER-IP"
VARIANT_SKU_PREFIX = "IP-"
#: Пометка активированного аппарата в артикуле (bsa_parser.Item.sku). Такой
#: вариант дешевле, но витриной модели его ставить нельзя — он не новый.
ACTIVATED_SUFFIX = "-ACT"


def variants_of(db: Session, product: Product) -> list[Product]:
    """Складские варианты аппарата из предзаказа, в наличии, дешёвые первыми."""
    sku = product.sku or ""
    if not sku.startswith(PREORDER_SKU_PREFIX):
        return []
    prefix = VARIANT_SKU_PREFIX + sku[len(PREORDER_SKU_PREFIX):] + "-"
    return db.execute(
        select(Product)
        .where(
            Product.sku.like(prefix + "%"),
            Product.is_active.is_(True),
            Product.in_stock.is_(True),
            Product.price > 0,
        )
        .order_by(Product.price.asc(), Product.id.asc())
    ).scalars().all()

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
    members = db.execute(
        select(Product)
        .where(
            Product.availability_mode == "preorder",
            Product.preorder_group == group,
        )
        .order_by(Product.id.asc())
    ).scalars().all()

    products: list[Product] = []
    arrived: list[tuple[Product, list[Product]]] = []
    for member in members:
        variants = variants_of(db, member)
        if variants:
            arrived.append((member, variants))
        elif member.is_active:
            products.append(member)

    cards = [p.to_card() for p in products]
    apply_group_images(db, products, cards)
    # Описание — единственное, ради чего экран отличается от каталога: человек
    # читает про аппарат ровно перед тем, как решить. В обычную карточку ленты
    # оно не входит (там его негде показать), поэтому добавляем здесь, а не
    # раздуваем to_card() ради одного экрана.
    for card, product in zip(cards, products):
        card["description"] = product.description or ""
        # Три главные характеристики строкой-чипами под заголовком. Берём из
        # того же нормализованного списка, что и страница товара, — второй
        # разбор характеристик разъехался бы с первым на первом же товаре.
        card["chips"] = product._specifications()[:3]

    arrived_cards = []
    for member, variants in arrived:
        card = member.to_card()
        apply_group_images(db, [member], [card])
        card["description"] = member.description or ""
        card["chips"] = member._specifications()[:3]
        new = [v for v in variants if not (v.sku or "").endswith(ACTIVATED_SUFFIX)]
        offer = (new or variants)[0]
        offer_card = offer.to_card()
        apply_group_images(db, [offer], [offer_card])
        card["offer"] = offer_card
        card["variants"] = len(variants)
        card["min_price"] = float(variants[0].price)
        # Заголовок блока — модель, а не «256 ГБ»: вариантов памяти у неё теперь
        # несколько, и базовая комплектация из предзаказа ввела бы в заблуждение.
        card["title"] = model_key(member.title)
        card["query"] = card["title"].lower()
        arrived_cards.append(card)

    return {
        "banner": banner.to_dict() if banner else None,
        "items": cards,
        "arrived": arrived_cards,
    }
