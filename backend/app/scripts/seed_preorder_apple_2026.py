"""Линейка Apple, показанная 9 сентября 2026 — заводим предзаказом.

Запуск (идемпотентно, можно повторять):

    python -m app.scripts.seed_preorder_apple_2026

После него ОБЯЗАТЕЛЬНО:

    python -m app.scripts.internalize_photos --confirm

Фотографии здесь — внешние ссылки на CDN Apple, и живут они ровно до тех пор,
пока жив чужой сайт. Так уже сгорел прежний источник картинок (rocketniks.ru),
и вместе с ним осиротело всё, что он раздавал. См. docs/context/product-photos.md.

Три вещи, которые легко сломать при правке этого файла:

1. **Цены нет.** `price = 0` — это «числа нет», а не «бесплатно». Витрина
   покажет `price_note` («Цену уточнит менеджер»), потому что режим
   `availability_mode="preorder"`. Поставить сюда настоящую цену значит дать
   обещание, которого магазин не давал.
2. **Соглашения имён ассетов у линеек РАЗНЫЕ.** У iPhone дата стоит после
   номера (`iphone-18-pro-gallery-1-202609`), у AirPods — перед словом
   (`airpods-5-202609-gallery-1`), а у часов галерей нет вовсе: кадр
   склеивается из слоёв «ремешок + корпус + циферблат» через `+`, и кодировать
   плюс нельзя. Угадать одну схему по другой невозможно — проверено.
3. **`finish-select` отдаётся в 16:9.** Без `cropN` Scene7 дорисовывает белые
   полосы сверху и снизу, и на плитке это читается как рамка вокруг серого
   прямоугольника.
"""
from __future__ import annotations

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.home import HomeBanner
from app.models.product import Product

GROUP = "apple-sept-2026"
BANNER_IMAGE = "/assets/promos/apple-sept-2026.webp"

_BASE = "https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is"
_SQUARE = "wid=1200&hei=1200&fmt=jpeg&qlt=90"
_CROP_16X9 = "cropN=0.21875,0,0.5625,1"


def _url(asset: str, *, crop: bool = False) -> str:
    query = f"{_CROP_16X9}&{_SQUARE}" if crop else _SQUARE
    return f"{_BASE}/{asset}?{query}"


#: Шесть устройств в том порядке, в каком они встанут на экране события:
#: порядок заведения = порядок показа (см. api/preorder.py).
DEVICES: list[dict] = [
    dict(
        sku="PREORDER-IP18PRO",
        title="iPhone 18 Pro 256 ГБ",
        category="смартфоны",
        subcategory="iPhone",
        preorder_eta="18 сентября",
        accent_color="#6E2639",
        screen_size="6,3″",
        storage="256 ГБ",
        description=(
            "Dynamic Island стал меньше, а основная камера получила переменную "
            "диафрагму — свет теперь дозируется точнее, и портрет в сумерках "
            "перестал быть лотереей. Четыре отделки титана, и burgundy среди них "
            "новая."
        ),
        specs={
            "Отделки": "burgundy, glacier, silver, black",
            "Память": "256 ГБ — 2 ТБ",
            "Корпус": "титан",
        },
        assets=[
            ("iphone-18-pro-finish-select-202609-6-3inch-burgundy", True),
            ("iphone-18-pro-finish-select-202609-6-3inch-glacier", True),
            ("iphone-18-pro-finish-select-202609-6-3inch-black", True),
            ("iphone-18-pro-gallery-1-202609", False),
        ],
    ),
    dict(
        sku="PREORDER-IP18PROMAX",
        title="iPhone 18 Pro Max 256 ГБ",
        category="смартфоны",
        subcategory="iPhone",
        preorder_eta="18 сентября",
        accent_color="#8A3D52",
        screen_size="6,9″",
        storage="256 ГБ",
        description=(
            "То же железо, что у Pro, на большом экране и с большим запасом "
            "батареи. Если выбираете между ними — разница только в размере и "
            "времени работы, всё остальное совпадает."
        ),
        specs={
            "Отделки": "burgundy, glacier, silver, black",
            "Память": "256 ГБ — 2 ТБ",
            "Корпус": "титан",
        },
        assets=[
            ("iphone-18-pro-finish-select-202609-6-9inch-burgundy", True),
            ("iphone-18-pro-finish-select-202609-6-9inch-glacier", True),
            ("iphone-18-pro-finish-select-202609-6-9inch-silver", True),
            ("iphone-18-pro-gallery-2-202609", False),
        ],
    ),
    dict(
        sku="PREORDER-IPDUO",
        title="iPhone Duo 256 ГБ",
        category="смартфоны",
        subcategory="iPhone",
        preorder_eta="23 октября",
        accent_color="#1E2A3A",
        screen_size="5,4″ / 7,6″",
        storage="256 ГБ",
        description=(
            "Первый складной iPhone: титановый корпус, 5,4 дюйма снаружи и 7,6 "
            "внутри. Приезжает позже остальных — здесь предзаказ имеет "
            "наибольший смысл, партия будет маленькой."
        ),
        specs={
            "Отделки": "star white, night sky",
            "Память": "256 ГБ — 2 ТБ",
            "Корпус": "титан, книжный форм-фактор",
        },
        assets=[
            ("iphone-duo-gallery-2-202609", False),
            ("iphone-duo-finish-select-202609-starwhite", True),
            ("iphone-duo-finish-select-202609-nightsky", True),
            ("iphone-duo-gallery-1-202609", False),
        ],
    ),
    dict(
        sku="PREORDER-WATCHS12",
        title="Apple Watch Series 12, 42 мм",
        category="часы",
        subcategory="Apple Watch",
        preorder_eta="18 сентября",
        accent_color="#B08432",
        description=(
            "Цена входа осталась прежней, сутки автономности — тоже. Прибавились "
            "керамические корпуса: pearl white и night blue раньше были только в "
            "мечтах."
        ),
        specs={
            "Корпус": "42 и 46 мм",
            "Материалы": "алюминий, титан, керамика",
            "Автономность": "сутки обычного дня",
        },
        assets=[
            ("MK864_VW_34FR_NCE+watch-case-42-titanium-radiantgold-cell-s12_VW_34FR"
             "+watch-face-42-titanium-radiantgold-s12_VW_34FR", False),
            ("MKRJ4ref_VW_34FR_CE+watch-case-42-ceramic-pearlwhite-cell-s12_VW_34FR"
             "+watch-face-42-ceramic-pearlwhite-cell-s12_VW_34FR", False),
            ("MKJV4ref_VW_34FR_CE+watch-case-42-ceramic-nightblue-cell-s12_VW_34FR"
             "+watch-face-42-ceramic-nightblue-cell-s12_VW_34FR", False),
            ("MJVC4ref_VW_34FR_NCE+watch-case-42-aluminum-spacegray-cell-s12_VW_34FR"
             "+watch-face-42-aluminum-spacegray-s12_VW_34FR", False),
        ],
    ),
    dict(
        sku="PREORDER-WATCHULTRA4",
        title="Apple Watch Ultra 4, 49 мм",
        category="часы",
        subcategory="Apple Watch",
        preorder_eta="18 сентября",
        accent_color="#3A3A3A",
        description=(
            "50 часов в обычном режиме и 84 в экономном — то есть выходные без "
            "зарядки перестали быть вопросом. Чёрный титан, ремешки Alpine и "
            "Milanese."
        ),
        specs={
            "Корпус": "49 мм, титан",
            "Автономность": "50 ч обычно, 84 ч в экономном режиме",
        },
        assets=[
            ("MKF04ref_VW_34FR+watch-case-49-titanium-black-ultra4_VW_34FR"
             "+watch-face-49-ultra4_VW_34FR_GEO_US", False),
            ("MK0F4ref_VW_34FR+watch-case-49-titanium-black-ultra4_VW_34FR"
             "+watch-face-49-ultra4_VW_34FR_GEO_US", False),
        ],
    ),
    dict(
        sku="PREORDER-AIRPODS5",
        title="AirPods 5",
        category="наушники",
        subcategory="AirPods",
        preorder_eta="18 сентября",
        accent_color="#5B7C99",
        description=(
            "Шумоподавление во вкладышах, которые не затыкают ухо, — редкое "
            "сочетание. Две версии: обычная и с беспроводной зарядкой футляра."
        ),
        specs={
            "Тип": "вкладыши, открытая посадка",
            "Шумоподавление": "активное",
        },
        assets=[
            ("airpods-5-202609-gallery-1", False),
            ("airpods-5-202609-gallery-3", False),
            ("airpods-5-202609-gallery-2", False),
            ("airpods-5-202609-gallery-4", False),
        ],
    ),
]


def _upsert_products(db) -> list[Product]:
    out: list[Product] = []
    for spec in DEVICES:
        data = dict(spec)
        assets = data.pop("assets")
        images = [_url(asset, crop=crop) for asset, crop in assets]

        product = db.execute(
            select(Product).where(Product.sku == data["sku"])
        ).scalars().first()
        if product is None:
            product = Product(title=data["title"], price=0)
            db.add(product)

        for field, value in data.items():
            setattr(product, field, value)

        product.brand = "Apple"
        product.price = 0                      # «числа нет», а не «бесплатно»
        product.old_price = None
        product.in_stock = False
        product.stock = 0
        product.is_active = True
        product.is_new = True
        product.condition = "new"
        product.warranty_months = 1
        product.source = "seed"
        product.availability_mode = "preorder"
        product.preorder_group = GROUP
        product.image = images[0]
        product.images = images
        out.append(product)

    db.commit()
    for p in out:
        db.refresh(p)
    return out


def _upsert_banner(db) -> HomeBanner:
    """Баннер события — первым в ленте; остальные съезжают на позицию ниже.

    Позиции пересчитываются целиком, а не сдвигаются на +1: сдвиг при повторном
    запуске отодвигал бы ленту всё дальше, и скрипт перестал бы быть
    идемпотентным.
    """
    banner = db.execute(
        select(HomeBanner).where(
            HomeBanner.action_type == "preorder",
            HomeBanner.action_value == GROUP,
        )
    ).scalars().first()
    if banner is None:
        banner = HomeBanner(title="", action_type="preorder", action_value=GROUP)
        db.add(banner)

    banner.title = "Шесть новых устройств"
    banner.subtitle = "Показали 9 сентября. Предзаказ открыт"
    banner.image_url = BANNER_IMAGE
    banner.emoji = None
    banner.is_active = True
    banner.position = 0
    db.flush()

    others = db.execute(
        select(HomeBanner)
        .where(HomeBanner.id != banner.id)
        .order_by(HomeBanner.position.asc(), HomeBanner.id.asc())
    ).scalars().all()
    for index, other in enumerate(others, start=1):
        other.position = index

    db.commit()
    db.refresh(banner)
    return banner


def main() -> None:
    db = SessionLocal()
    try:
        products = _upsert_products(db)
        banner = _upsert_banner(db)
    finally:
        db.close()

    print(f"Товаров в предзаказе: {len(products)}")
    for p in products:
        print(f"  {p.sku:24s} {p.title:34s} ожидается {p.preorder_eta}, фото {len(p.images)}")
    print(f"Баннер #{banner.id} «{banner.title}» на позиции {banner.position}")
    print()
    print("Дальше обязательно: python -m app.scripts.internalize_photos --confirm")


if __name__ == "__main__":
    main()
