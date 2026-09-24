"""iPhone 18 Pro / Pro Max приехали: витрина переходит из «предзаказа» в «наличие».

Что меняет (с --confirm; без него — только показывает):
1. первый баннер главной (событие apple-sept-2026): заголовок, подзаголовок и
   кадр — четыре цвета 18 Pro вместо линейки «скоро»;
2. карточки предзаказа 18 Pro / Pro Max уходят с витрины (is_active=False).
   С экрана события они НЕ пропадают: api/preorder показывает их в блоке
   «Уже в наличии» с реальными вариантами — описание живёт только там;
3. складские карточки 18 Pro / Pro Max получают флаг «новинка».

Идемпотентен: повторный запуск ничего не меняет.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.launch_iphone18 --confirm
"""
from __future__ import annotations

import argparse
import sys

from app.db.session import SessionLocal
from app.models.home import HomeBanner
from app.models.product import Product

GROUP = "apple-sept-2026"
BANNER = {
    "title": "iPhone 18 Pro приехали",
    "subtitle": "Четыре цвета в наличии. Duo — скоро",
    "image_url": "/assets/promos/iphone18-instock.webp",
}
PREORDER_SKUS = ("PREORDER-IP18PRO", "PREORDER-IP18PROMAX")
STOCK_PREFIX = "IP-18PRO"      # захватывает и IP-18PRO-, и IP-18PROMAX-


def apply(db) -> list[str]:
    changed: list[str] = []

    banner = (db.query(HomeBanner)
              .filter_by(action_type="preorder", action_value=GROUP).first())
    if banner is None:
        changed.append(f"!! баннер события {GROUP} не найден")
    else:
        for field, value in BANNER.items():
            if getattr(banner, field) != value:
                changed.append(f"баннер {field}: {getattr(banner, field)!r} -> {value!r}")
                setattr(banner, field, value)

    for row in db.query(Product).filter(Product.sku.in_(PREORDER_SKUS)):
        if row.is_active:
            row.is_active = False
            changed.append(f"снят с витрины {row.sku}")

    fresh = (db.query(Product)
             .filter(Product.sku.like(STOCK_PREFIX + "%"), Product.is_new.is_(False))
             .all())
    for row in fresh:
        row.is_new = True
    if fresh:
        changed.append(f"«новинка» у {len(fresh)} карточек")

    db.flush()
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        changed = apply(db)
        print("\n".join(changed) if changed else "изменений нет")
        if args.confirm:
            db.commit()
            print("\nприменено")
        else:
            db.rollback()
            print("\nпредпросмотр, для применения — --confirm")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
