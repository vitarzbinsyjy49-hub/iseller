"""Убрать вписанные цены из инфо-постов канала (09.10.2026).

В «Поступлениях сентября» (№61) и «iPhone 18 в наличии» (№65) цены были
вписаны в текст при публикации и с тех пор не обновлялись: 63 цены, часть из
них уже неверна. Цена должна жить только там, где обновляется сама — прайс-посты
(ежедневно, services/daily_price_sync) и приложение. Здесь вместо цифр —
отсылка к ним; кнопки на разделы прайса в обоих постах уже есть.

    python -m app.scripts.strip_info_post_prices            # предпросмотр
    python -m app.scripts.strip_info_post_prices --confirm  # правка в канале
"""
from __future__ import annotations

import argparse
import re
import sys

from app.db.session import SessionLocal
from app.models.post import ChannelPost
from app.services import price_channel

ARRIVALS = "info_arrivals_2026_09"
IPHONE18 = "info_iphone18_instock"

PRICE_NOTE = "💰 Актуальные цены — в прайсе канала (кнопки ниже) и в приложении, обновляются каждый день."

_PRICE_TAIL = re.compile(r"\s+—\s+[\d\s ]+₽\s*$")


def strip_arrivals(body: str) -> str:
    lines = [_PRICE_TAIL.sub("", line) if line.startswith("• ") else line for line in body.splitlines()]
    text = "\n".join(lines)
    old_tail = "Фото, характеристики и наличие — в приложении."
    if PRICE_NOTE not in text:
        text = text.replace(old_tail, PRICE_NOTE + "\n\n" + old_tail) if old_tail in text else text + "\n\n" + PRICE_NOTE
    return text


_IPHONE_BLOCK = re.compile(
    r"<details>\s*<summary><b>iPhone 18 Pro — от[^<]*</b></summary>.*?</details>\s*"
    r"<details>\s*<summary><b>iPhone 18 Pro Max — от[^<]*</b></summary>.*?</details>",
    re.S)

_IPHONE_NEW = ("<details>\n<summary><b>Память и цены</b></summary>\n"
               "<p>iPhone 18 Pro и Pro Max — 256 ГБ, 512 ГБ, 1 ТБ и 2 ТБ. Цены меняются вместе с рынком, "
               "поэтому мы держим их в одном месте: кнопка «Все цены на iPhone» ниже и приложение — "
               "там всегда актуально.</p>\n</details>")


def strip_iphone18(html: str) -> str:
    return _IPHONE_BLOCK.sub(_IPHONE_NEW, html, count=1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        arrivals = db.query(ChannelPost).filter_by(slug=ARRIVALS).one()
        iphone = db.query(ChannelPost).filter_by(slug=IPHONE18).one()
        new_arrivals = strip_arrivals(arrivals.body)
        new_iphone = strip_iphone18(iphone.rich_html or "")
        for name, text in ((ARRIVALS, new_arrivals), (IPHONE18, new_iphone)):
            left = re.findall(r"\d[\d  ]{2,}\s?₽", text)
            print(f"===== {name}: цен осталось {len(left)}\n{text}\n")
        if new_iphone == (iphone.rich_html or ""):
            print("!! блок цен iPhone 18 не найден — пост не трогаю")
            return 1
        if not args.confirm:
            print("Это предпросмотр. Для правки в канале добавьте --confirm.")
            return 0
        arrivals.body = new_arrivals
        iphone.rich_html = new_iphone
        db.commit()
        result = price_channel.apply_info_posts(db, slugs=[ARRIVALS, IPHONE18])
        db.commit()
        print("обновлено:", result.updated, "ошибки:", result.failed)
        return 1 if result.failed else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
