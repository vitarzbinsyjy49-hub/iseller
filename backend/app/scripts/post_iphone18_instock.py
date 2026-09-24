"""iPhone 18 Pro / Pro Max приехали: пост в канал и снятие предзаказа.

Разовый, но идемпотентный — как post_preorder_apple_2026: пост живёт под
стабильным slug'ом, повторный запуск правит то же сообщение, а не плодит дубль.

Что делает с --confirm:
1. снимает с витрины карточки предзаказа 18 Pro / Pro Max (PREORDER-IP18PRO*):
   аппарат приехал, и карточка «цену уточнит менеджер» рядом с настоящими
   ценами только сбивает. is_active=False, а не удаление: на них ссылаются
   заявки предзаказа. Duo, часы и AirPods остаются на экране события;
2. помечает новые карточки 18 Pro / Pro Max (заведены import_bsa) флагом
   «новинка»;
3. публикует пост с кадром всех четырёх цветов.

Цены «от» НЕ зашиты в текст, а берутся из базы в момент запуска: пост обязан
совпадать с тем, что покупатель увидит в приложении (docs/context/channel-posts.md).

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.post_iphone18_instock --confirm
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from sqlalchemy import func

from app.core.uploads import save_image
from app.db.session import SessionLocal
from app.models.post import ChannelPost
from app.models.product import Product
from app.services import price_channel
from app.services.info_posts import INFO_KIND

SLUG = "info_iphone18_instock"
IMAGE = Path(__file__).with_name("data") / "iphone18-instock-post.webp"
TITLE = "iPhone 18 Pro / Pro Max в наличии"

PREORDER_SKUS = ("PREORDER-IP18PRO", "PREORDER-IP18PROMAX")
#: Префиксы артикулов из bsa_parser.Item.sku. «IP-18PRO-» не захватывает
#: «IP-18PROMAX-»: после PRO сразу дефис.
MODELS = (("iPhone 18 Pro", "IP-18PRO-"), ("iPhone 18 Pro Max", "IP-18PROMAX-"))

CAPTION_LIMIT = 1024


def rub(value: float) -> str:
    return f"{int(value):,}".replace(",", " ") + " ₽"


def min_price(db, prefix: str, activated: bool) -> float | None:
    query = db.query(func.min(Product.price)).filter(
        Product.sku.like(prefix + "%"), Product.is_active.is_(True),
        Product.in_stock.is_(True), Product.price > 0,
    )
    query = query.filter(Product.sku.like("%-ACT") if activated
                         else ~Product.sku.like("%-ACT"))
    return query.scalar()


def build_body(db) -> str:
    lines, act_lines = [], []
    for name, prefix in MODELS:
        new, act = min_price(db, prefix, False), min_price(db, prefix, True)
        if new is None:
            raise SystemExit(f"!! нет карточек {name} в каталоге — сначала import_bsa")
        lines.append(f"• <b>{name}</b> — от {rub(new)}")
        if act is not None:
            act_lines.append(f"{name.replace('iPhone ', '')} от {rub(act)}")

    body = (
        "📱 <b>iPHONE 18 PRO И PRO MAX — В НАЛИЧИИ</b>\n"
        "\n"
        "Приехали. Все четыре цвета — burgundy, glacier, silver и black, "
        "память от 256 ГБ до 2 ТБ.\n"
        "\n"
        + "\n".join(lines) + "\n"
        "\n"
        "Есть версии с физической SIM + eSIM и только с eSIM — регион указан "
        "в каждой карточке."
    )
    if act_lines:
        body += (" Активированные аппараты (новые, но уже включённые) дешевле: "
                 + ", ".join(act_lines) + ".")
    body += (
        "\n\n"
        "Гарантия магазина — 1 месяц. Цена каждой версии — в приложении "
        "и в прайсе канала."
    )
    return body


STORAGES = ("256 ГБ", "512 ГБ", "1 ТБ", "2 ТБ")


def storage_table(db, prefix: str) -> list[tuple[str, float]]:
    """Память -> самая низкая цена новой версии. Пустые объёмы пропускаются."""
    rows = []
    for storage in STORAGES:
        # В артикуле объём — только число: «1 ТБ» -> «1» (bsa_parser.Item.sku).
        token = storage.split()[0]
        price = (db.query(func.min(Product.price))
                 .filter(Product.sku.like(f"{prefix}{token}-%"),
                         Product.is_active.is_(True), Product.in_stock.is_(True),
                         Product.price > 0, ~Product.sku.like("%-ACT"))
                 .scalar())
        if price is not None:
            rows.append((storage, price))
    return rows


def build_rich(db, image_url: str | None) -> str:
    """Rich-версия поста — по методике постов канала (artifacts/channel-posts):
    заголовок, кадр, короткий лид, цитата, раскрывающиеся блоки с таблицами.

    Таблица по памяти, а не по регионам: человек выбирает объём, регион и SIM
    уточняются в карточке. Цифры — из базы в момент запуска, как и в body."""
    parts = ["<h3>iPhone 18 Pro и Pro Max приехали</h3>"]
    if image_url:
        parts.append(f'<img src="{image_url}"/>')
    parts.append(
        "<p>Все четыре цвета — Burgundy, Glacier, Silver и Black, память от 256 ГБ "
        "до 2 ТБ. Аппараты новые, не активированные.</p>")
    parts.append(
        "<blockquote>Burgundy — новый цвет этого поколения. Живьём он темнее "
        "и спокойнее, чем на рендерах.</blockquote>")
    parts.append("<hr/>")
    for name, prefix in MODELS:
        table = storage_table(db, prefix)
        if not table:
            continue
        cells = "".join(f"<tr><td><b>{st}</b></td><td>от {rub(pr)}</td></tr>"
                        for st, pr in table)
        parts.append(f"<details>\n<summary><b>{name} — от {rub(table[0][1])}</b></summary>\n"
                     f"<table>{cells}</table>\n</details>")
    parts.append(
        "<details>\n<summary><b>SIM + eSIM или только eSIM</b></summary>\n"
        "<p>Версии для Кореи и Гонконга — с физической SIM и eSIM. Версии для США "
        "и Кувейта — только eSIM, они дешевле. Если пользуетесь обычной "
        "SIM-картой — берите SIM + eSIM; регион указан в каждой карточке.</p>\n"
        "</details>")
    parts.append(
        "<details>\n<summary><b>А что с Duo, часами и AirPods</b></summary>\n"
        "<p>iPhone Duo ждём 23 октября, Apple Watch Series 12, Ultra 4 и AirPods 5 "
        "— следом. На всё открыт предзаказ без предоплаты: менеджер свяжется, "
        "назовёт цену и срок.</p>\n</details>")
    parts.append("<hr/>")
    parts.append("<footer>Цена каждой версии — в приложении и в прайсе канала. "
                 "Гарантия магазина — 1 месяц.</footer>")
    return "\n\n".join(parts)


def buttons() -> list[dict]:
    """Главная кнопка ведёт на экран события: там обе модели с описанием и
    выходом ко всем вариантам — тот же экран, что у первого баннера главной."""
    specs = [
        {"text": "📱 Смотреть iPhone 18 Pro", "kind": "preorder", "value": "apple-sept-2026", "row": 0},
        {"text": "💰 Все цены на iPhone", "kind": "section", "value": "price_iphone", "row": 1},
        {"text": "💬 Менеджер", "kind": "manager", "row": 1},
    ]
    return specs


def plain_length(html: str) -> int:
    return len(re.sub(r"<[^>]+>", "", html))


def prepare(db, body: str, *, dry_run: bool,
            republish: bool = False) -> tuple[ChannelPost, list[str]]:
    changed: list[str] = []

    for sku in PREORDER_SKUS:
        row = db.query(Product).filter_by(sku=sku).one_or_none()
        if row is not None and row.is_active:
            row.is_active = False
            changed.append(f"снят предзаказ {sku}")

    fresh = (db.query(Product)
             .filter(Product.sku.like("IP-18PRO%"), Product.is_new.is_(False))
             .all())
    for row in fresh:
        row.is_new = True
    if fresh:
        changed.append(f"«новинка» у {len(fresh)} карточек")

    post = db.query(ChannelPost).filter_by(slug=SLUG).one_or_none()
    if post is None:
        post = ChannelPost(slug=SLUG, kind=INFO_KIND, sort_order=101)
        db.add(post)
        changed.append("создан черновик поста")
    if post.title != TITLE:
        post.title = TITLE
    if post.body != body:
        post.body = body
        changed.append("текст")
        if post.telegram_message_id:
            post.status = "outdated"
    spec = buttons()
    if post.button_spec != spec:
        post.button_spec = spec
        changed.append("кнопки")
    # Картинку кладём в загрузки один раз: save_image даёт каждому вызову новое
    # имя. В предпросмотре не кладём вовсе — после rollback файл остался бы
    # на диске ничьим.
    if not post.image_url and not dry_run:
        post.image_url = save_image("image/webp", IMAGE.read_bytes())
        changed.append(f"картинка: {post.image_url}")

    rich = build_rich(db, post.image_url)
    if post.rich_html != rich:
        post.rich_html = rich
        changed.append("rich-версия")
        if post.telegram_message_id:
            post.status = "outdated"
    # Фото с подписью Telegram не превращает в rich-текст правкой: сообщение
    # приходится публиковать заново. Старое удаляется РУКАМИ в канале.
    if republish and post.telegram_message_id:
        changed.append(f"публикуем заново; старое сообщение {post.telegram_message_id} "
                       "удалите в канале вручную")
        post.telegram_message_id = None
        post.status = "draft"

    db.flush()
    return post, changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true",
                        help="применить и опубликовать (без него — только показать)")
    parser.add_argument("--republish", action="store_true",
                        help="опубликовать новым сообщением (переход с фото на rich)")
    args = parser.parse_args()
    dry_run = not args.confirm

    if not IMAGE.is_file():
        print(f"!! нет файла картинки: {IMAGE}")
        return 1

    db = SessionLocal()
    try:
        body = build_body(db)
        print(body, "\n")
        length = plain_length(body)
        print(f"длина подписи: {length} из {CAPTION_LIMIT}")
        if length > CAPTION_LIMIT:
            print("!! подпись длиннее предела Telegram — сократите текст")
            return 1

        post, changed = prepare(db, body, dry_run=dry_run, republish=args.republish)
        print(post.rich_html, "\n")
        print("изменения:", ", ".join(changed) if changed else "нет")
        print("в канале:", f"message_id={post.telegram_message_id}"
              if post.telegram_message_id else "ещё не публиковался")
        if not dry_run:
            db.commit()

        result = price_channel.apply_info_posts(db, slugs=[SLUG], dry_run=dry_run)
        print("создано: ", result.created)
        print("обновлено:", result.updated)
        print("ошибки:   ", result.failed)

        if dry_run:
            db.rollback()
            print("\nПредпросмотр: в канал ничего не ушло, база не изменена. "
                  "Для публикации — --confirm.")
        return 1 if result.failed else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
