"""Перекачать фото iPhone 18 Pro / Pro Max с плотным кропом (import_bsa.APPLE_CROP).

Карточки заводились с кропом «квадрат по центру», где аппарат занимал около
половины кадра. Импорт теперь берёт плотный кроп, а этот скрипт догоняет уже
заведённые карточки: одно скачивание на модель+цвет, у всех её вариантов
главное фото и галерея заменяются. Без --confirm — только показывает.

    docker compose -f docker-compose.prod.yml exec -T backend \
        python -m app.scripts.refresh_iphone18_photos --confirm
"""
from __future__ import annotations

import argparse
import sys

from app.db.session import SessionLocal
from app.models.product import Product
from app.scripts.import_bsa import PHOTOS_IPHONE, fetch_photo
from app.services.variants import COLOR_AXIS, family_and_variant

MODELS = {"Apple iPhone 18 Pro": "18 Pro", "Apple iPhone 18 Pro Max": "18 Pro Max"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    db = SessionLocal()
    try:
        rows = db.query(Product).filter(Product.sku.like("IP-18PRO%")).all()
        plan: dict[str, list[Product]] = {}
        for row in rows:
            fv = family_and_variant(row)
            if not fv or fv[0] not in MODELS:
                continue
            url = PHOTOS_IPHONE.get((MODELS[fv[0]], fv[1].get(COLOR_AXIS, "")))
            if url:
                plan.setdefault(url, []).append(row)
        for url, group in plan.items():
            print(f"{len(group):3}  {url.split('/')[-1][:60]}")
        if not args.confirm:
            print("\nпредпросмотр, для замены — --confirm")
            return 0
        replaced, failed = 0, 0
        for url, group in plan.items():
            saved = fetch_photo(url)
            if not saved:
                failed += len(group)      # старое фото остаётся — повторный прогон догонит
                continue
            for row in group:
                row.image = saved
                row.images = [saved]
            replaced += len(group)
        db.commit()
        print(f"\nзаменено: {replaced} карточек, не удалось: {failed}")
        return 1 if failed else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
