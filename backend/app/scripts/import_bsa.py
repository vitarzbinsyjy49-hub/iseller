"""Залить прайс BSA в каталог: позиции, цены, фотографии.

Цена витрины = цена поставщика минус NAKIDKA (см. ниже). Гарантия — месяц,
как везде в магазине. Регион кладётся кодами в скобки названия, флаг из него
делает витрина сама.

Фотографии берутся с нашего же сайта rocketniks.ru. Картинка там зависит
только от МОДЕЛИ и ЦВЕТА, не от объёма памяти, SIM и региона: у «Pro Max 256
синий» и «Pro Max 512 синий» один файл. Поэтому 175 позиций закрываются
тремя десятками картинок, а карта соответствий лежит константой PHOTOS.

Идемпотентен: позиции ищутся по артикулу, существующим обновляется цена и
наличие. Фото не перекачивается, если у товара уже есть картинка, — иначе
каждый прогон плодил бы копии одного файла в uploads.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.import_bsa --confirm
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import httpx

from app.core.uploads import save_image
from app.db.session import SessionLocal
from app.models.product import Product
from app.services.bsa_parser import Item, MacItem, parse, parse_mac

DATA = Path(__file__).resolve().parent / "data"

#: На сколько мы дешевле поставщика. Владелец сказал «на 300–500 рублей
#: дешевле»; берём нижнюю границу диапазона одним числом, чтобы правило было
#: проверяемым, а не «примерно».
NAKIDKA = 500

#: Модель + цвет -> фото на нашем сайте. Ключи для iPhone — («модель», «цвет»),
#: для остального — подстрока названия.
PHOTOS_IPHONE: dict[tuple[str, str], str] = {
    ("17 Pro Max", "Blue"): "49b305d8a8d2e7b2ea98b3e1ad5fda41.webp",
    ("17 Pro Max", "Orange"): "abb73c3897d11d3780b0b9b6f688c093.webp",
    ("17 Pro Max", "Silver"): "ae3ee49a82ad2f7c356e61b4a81c63a2.webp",
    ("17 Pro", "Blue"): "fd4ad356baccb74a22e997a6b2879685.webp",
    ("17 Pro", "Orange"): "7e1f6ed47e2dfbf32ef50c968d6e5f2c.webp",
    ("17 Pro", "Silver"): "4d1489f5df3748a6a7076e092c3529c9.webp",
    ("17", "Black"): "e0511e9eaa9832e2190f2f3641752e2f.webp",
    ("17", "White"): "06df427839007b6e6761f95ed5720146.webp",
    ("17", "Blue"): "e5b2b73b4ae1ed45fdd56f31deefd862.webp",
    ("17", "Sage"): "ab2182a98be304ce5aecffdfe51db878.webp",
    ("17", "Lavender"): "f2268c01fcbc933dcbdc5f2fcf1f3a64.webp",
}

#: Для Mac/мониторов совпадение по подстроке названия, сверху вниз.
PHOTOS_MAC: tuple[tuple[str, str], ...] = (
    ("mac mini", "abc137926d34374a4f8f9a9b708ff5eb.webp"),
    ("mac studio", "9489089b803858e84df26870a3b6230c.webp"),
    ("studio display", "f39eebfdd0bf0f817d1915e9624b9dde.jpg"),
    ("pro display", "f39eebfdd0bf0f817d1915e9624b9dde.jpg"),
    ("imac m4 (10/10/16/256) silver", "0599f820873518b7c95a4aef360874aa.webp"),
    ("imac m4 (10/10/24/512) silver", "0599f820873518b7c95a4aef360874aa.webp"),
    ("silver", "0599f820873518b7c95a4aef360874aa.webp"),
    ("purple", "cd3d2eff72c735c747dd41cd0134c822.webp"),
    ("orange", "672f30057dcddb727dbbf390ad5eb711.webp"),
    ("pink", "c327f82304a535499953d3231638bddb.webp"),
    ("green", "c11d28ef9a605c3ed9c15eb8e90dc505.webp"),
    ("yellow", "b56ea204630d473ed30bd906fd35e97a.webp"),
    ("blue", "76f17ca9f8ae5f401186affe5d1297d7.webp"),
)

PHOTO_BASE = "http://api.rocketniks.ru/images/products/"

#: Кэш «имя файла на сайте -> наш путь /api/uploads/...». Один файл качается
#: один раз за прогон, даже если его просят двадцать позиций.
_downloaded: dict[str, str] = {}


def fetch_photo(name: str) -> str | None:
    """Скачать картинку и положить к нам. None, если не получилось."""
    if name in _downloaded:
        return _downloaded[name]
    try:
        response = httpx.get(PHOTO_BASE + name, timeout=30, follow_redirects=True)
        response.raise_for_status()
    except Exception as exc:  # noqa: BLE001 — сеть, причин отказа много
        print(f"   !! фото {name}: {exc}")
        return None

    content_type = response.headers.get("content-type", "").split(";")[0].strip()
    if content_type not in ("image/jpeg", "image/png", "image/webp"):
        print(f"   !! фото {name}: неожиданный тип {content_type!r}")
        return None
    url = save_image(content_type, response.content)
    _downloaded[name] = url
    return url


def photo_for_iphone(item: Item) -> str | None:
    return PHOTOS_IPHONE.get((item.model, item.color))


def photo_for_mac(item: MacItem) -> str | None:
    low = item.title.lower()
    for key, name in PHOTOS_MAC:
        if key in low:
            return name
    return None


#: Префикс названия -> подкатегория. Порядок важен: «Mac Studio» и «Mac mini»
#: должны проверяться раньше общих правил, иначе ничего бы не отличало их.
#: «Pro Stand» и «VESA Mount Adapter» — не отдельная категория, а штатные
#: аксессуары именно Pro Display XDR (Apple продаёт их только к нему),
#: поэтому идут в ту же подкатегорию, а не в общую «Аксессуары».
_MAC_SUBCATEGORY_RULES: tuple[tuple[str, str], ...] = (
    ("mac mini", "Mac mini"),
    ("mac studio", "Mac Studio"),
    ("imac", "iMac"),
    ("studio display", "Studio Display"),
    ("pro display", "Pro Display XDR"),
    ("pro stand", "Pro Display XDR"),
    ("vesa", "Pro Display XDR"),
    ("magic keyboard", "Magic Keyboard"),
)


def mac_subcategory(title: str) -> str:
    """Подкатегория по названию: «Mac Mini M4 (16/256)» -> «Mac mini».

    Нужна для того же, для чего у iPhone подкатегория «iPhone», — раздел
    прайса в канале отбирает товары ИМЕННО по ней (services/price_posts.
    matches), а не по индивидуальному вхождению текста. Без подкатегории
    товар в базе есть, а раздел прайса его никогда не найдёт — ровно так
    и не заметили, что 175 позиций BSA не попадают ни в один раздел.

    Слово «Apple» в начале строки снимаем перед сравнением: в дампе
    поставщика оно есть не у всех строк («Mac Mini M4 …», но «Apple Pro
    Display XDR …») — случайность форматирования прайса, не сигнал о разных
    брендах.
    """
    low = title.lower()
    if low.startswith("apple "):
        low = low[len("apple "):]
    for key, label in _MAC_SUBCATEGORY_RULES:
        if low.startswith(key):
            return label
    return "Аксессуары"


def upsert(db, *, sku: str, title: str, price: int, category: str,
           subcategory: str, brand: str, photo_name: str | None, dry_run: bool) -> str:
    """Создать или обновить позицию. Возвращает «создан»/«обновлён»/«без изменений»."""
    row = db.query(Product).filter_by(sku=sku).one_or_none()
    final_price = max(price - NAKIDKA, 0)

    if row is None:
        if dry_run:
            return "создан"
        row = Product(sku=sku, title=title, brand=brand, category=category,
                      subcategory=subcategory,
                      price=final_price, in_stock=True, stock=1, is_active=True,
                      warranty_months=1, source="bsa")
        if photo_name:
            url = fetch_photo(photo_name)
            if url:
                row.image = url
        db.add(row)
        return "создан"

    changed = row.price != final_price or row.title != title
    if not dry_run:
        row.price = final_price
        row.title = title
        row.category = category
        row.subcategory = subcategory
        row.warranty_months = 1
        row.in_stock = True
        row.is_active = True
        # Фото не перекачиваем: у товара оно уже есть, а повторная загрузка
        # плодила бы копии одного файла в uploads на каждом прогоне.
        if not row.image and photo_name:
            url = fetch_photo(photo_name)
            if url:
                row.image = url
    return "обновлён" if changed else "без изменений"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    dry_run = not args.confirm

    phones, failed_phones = parse((DATA / "bsa_2026_08_11.txt").read_text(encoding="utf-8"))
    macs, failed_macs = parse_mac((DATA / "bsa_mac_2026_08_11.txt").read_text(encoding="utf-8"))
    if failed_phones or failed_macs:
        print("!! не разобраны строки, импорт остановлен:")
        for line in failed_phones + failed_macs:
            print("   ", line)
        return 1

    print(f"разобрано: {len(phones)} iPhone + {len(macs)} Mac/мониторы/аксессуары")
    print(f"цена витрины = цена поставщика − {NAKIDKA} ₽, гарантия 1 месяц\n")

    db = SessionLocal()
    stats: dict[str, int] = {}
    no_photo: list[str] = []
    try:
        for item in phones:
            photo = photo_for_iphone(item)
            if photo is None:
                no_photo.append(item.sku)
            result = upsert(db, sku=item.sku, title=item.title, price=item.price,
                            category="смартфоны", subcategory="iPhone", brand="Apple",
                            photo_name=photo, dry_run=dry_run)
            stats[result] = stats.get(result, 0) + 1

        for mac in macs:
            photo = photo_for_mac(mac)
            if photo is None:
                no_photo.append(mac.sku)
            result = upsert(db, sku=mac.sku, title=mac.full_title, price=mac.price,
                            category=mac.category, subcategory=mac_subcategory(mac.title),
                            brand="Apple", photo_name=photo, dry_run=dry_run)
            stats[result] = stats.get(result, 0) + 1

        if dry_run:
            db.rollback()
        else:
            db.commit()

        for key in ("создан", "обновлён", "без изменений"):
            print(f"   {key:<16} {stats.get(key, 0)}")
        print(f"   без фото:        {len(no_photo)}")
        if no_photo:
            print("     ", ", ".join(no_photo[:8]), "…" if len(no_photo) > 8 else "")
        if dry_run:
            print("\nЭто предпросмотр. Для выполнения добавьте --confirm.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
