"""Пост о пополнении каталога: текст собирается ИЗ КАТАЛОГА, не из головы.

Цены в посте обязаны совпадать с тем, что покупатель увидит в приложении,
иначе пост становится ловушкой: человек приходит по «от 93 000», а в карточке
другое число. Поэтому семьи и минимальные цены считаются запросом к базе, а
не вписываются руками.

Пост создаётся как обычный инфо-пост канала (slug info_new_arrivals): дальше
он редактируется в админке и переиздаётся на том же message_id, как все
остальные. Отдельной механики публикации здесь нет — используется общая.

    # показать текст, ничего не публикуя
    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.post_new_arrivals

    # создать/обновить пост и опубликовать в канал
    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.post_new_arrivals --confirm
"""
from __future__ import annotations

import argparse
import re
import sys

from app.db.session import SessionLocal
from app.models.post import ChannelPost
from app.models.product import Product
from app.services import price_channel
from app.services.info_posts import DEFAULT_BUTTONS, INFO_KIND

SLUG = "info_new_arrivals"

#: Семьи в порядке показа: (подпись, regex по названию). Порядок ручной —
#: он отражает то, ради чего люди приходят, а не алфавит.
FAMILIES: tuple[tuple[str, str], ...] = (
    ("iPhone 17 Pro Max", r"^Apple iPhone 17 Pro Max\b"),
    ("iPhone 17 Pro", r"^Apple iPhone 17 Pro\b(?! Max)"),
    ("iPhone 17", r"^Apple iPhone 17\b(?! Pro)(?!e)"),
    ("iPhone 17e", r"^Apple iPhone 17e\b"),
    ("Mac mini", r"^Apple Mac Mini\b"),
    ("iMac", r"^Apple iMac\b"),
    ("Mac Studio", r"^Apple Mac Studio\b"),
    ("Studio Display", r"^Apple Studio Display\b"),
    ("Pro Display XDR", r"^Apple Apple Pro Display\b"),
    ("Magic Keyboard", r"^Apple Magic Keyboard\b"),
)

GROUPS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("📱", "iPhone 17", ("iPhone 17 Pro Max", "iPhone 17 Pro", "iPhone 17", "iPhone 17e")),
    ("🖥", "Компьютеры и мониторы",
     ("Mac mini", "iMac", "Mac Studio", "Studio Display", "Pro Display XDR")),
    ("⌨️", "Аксессуары", ("Magic Keyboard",)),
)


def money(value: int) -> str:
    return f"{value:,}".replace(",", " ") + " ₽"


def collect(db) -> tuple[dict[str, tuple[int, int]], int]:
    """{семья: (сколько, минимальная цена)} + всего новых позиций."""
    rows = db.query(Product).filter(
        Product.source == "bsa", Product.is_active.is_(True)).all()
    found: dict[str, tuple[int, int]] = {}
    for label, pattern in FAMILIES:
        matched = [r for r in rows if re.match(pattern, r.title or "")]
        if matched:
            found[label] = (len(matched), int(min(r.price for r in matched)))
    return found, len(rows)


def build_text(found: dict[str, tuple[int, int]], total: int) -> str:
    lines = [
        "🆕 <b>ПОПОЛНЕНИЕ КАТАЛОГА</b>",
        "",
        f"В приложении появились {total} новых позиций: iPhone 17, "
        "компьютеры Mac, мониторы и аксессуары Apple.",
    ]
    for emoji, title, labels in GROUPS:
        present = [(l, found[l]) for l in labels if l in found]
        if not present:
            continue
        lines += ["", f"{emoji} <b>{title}</b>"]
        for label, (count, low) in present:
            lines.append(f"• {label} — от {money(low)} <i>({count} вариантов)</i>")

    lines += [
        "",
        "Рядом с каждой позицией в приложении стоит флаг страны: от региона "
        "зависят комплект и вариант SIM. Точную конфигурацию менеджер "
        "подтвердит до оплаты.",
        "",
        "<b>Гарантия 1 месяц, проверку делаем вместе до оплаты.</b> "
        "Самовывоз — Горбушка, Москва, 10:00–21:00.",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        found, total = collect(db)
        if not found:
            print("новых позиций не нашлось — публиковать нечего")
            return 1
        text = build_text(found, total)

        print("=" * 62)
        print(text)
        print("=" * 62)
        print(f"длина: {len(text)} символов (лимит Telegram — 4096)\n")

        if not args.confirm:
            print("Это предпросмотр. Для публикации добавьте --confirm.")
            return 0

        row = db.query(ChannelPost).filter_by(slug=SLUG).one_or_none()
        if row is None:
            row = ChannelPost(slug=SLUG, kind=INFO_KIND, status="draft",
                              sort_order=900, button_spec=list(DEFAULT_BUTTONS))
            db.add(row)
        row.title = "Пополнение каталога"
        row.body = text
        if row.telegram_message_id:
            row.status = "outdated"
        db.commit()

        result = price_channel.apply_info_posts(db, slugs=[SLUG])
        print("создано: ", result.created)
        print("обновлено:", result.updated)
        print("ошибки:  ", result.failed)
        return 1 if result.failed else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
