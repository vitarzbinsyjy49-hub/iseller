"""Проставить «можно забрать сегодня» товарам в наличии.

Признак задумывался как отметка исключения и до сих пор стоял у одного
товара из 216: остальные приехали импортом, а колонки is_available_today в
файлах импорта нет — все получили False. Раздел «Забрать сегодня» на витрине
показывал одну позицию.

Что делает: ставит флаг всем активным товарам в наличии. Товары, снятые с
публикации или отсутствующие, не трогает — «забрать сегодня» то, чего нет,
нельзя.

Флаг остаётся редактируемым в админке: это по-прежнему решение магазина, а не
вычисляемое значение. Исключение помечается снятием галочки.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.set_available_today --confirm
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import func, select

from app.db.session import SessionLocal
from app.models.product import Product


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true",
                        help="выполнить обновление (без него — только показать)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        active = db.scalar(select(func.count()).select_from(Product)
                           .where(Product.is_active.is_(True)))
        with_flag = db.scalar(select(func.count()).select_from(Product)
                              .where(Product.is_active.is_(True),
                                     Product.is_available_today.is_(True)))
        targets = db.scalars(
            select(Product).where(Product.is_active.is_(True),
                                  Product.in_stock.is_(True),
                                  Product.is_available_today.is_(False))
        ).all()

        print(f"активных товаров:            {active}")
        print(f"уже с флагом:                {with_flag}")
        print(f"получат флаг:                {len(targets)}")

        if not args.confirm:
            print("\nЭто предпросмотр. Для выполнения добавьте --confirm.")
            return 0

        for product in targets:
            product.is_available_today = True
        db.commit()

        now_with_flag = db.scalar(select(func.count()).select_from(Product)
                                  .where(Product.is_active.is_(True),
                                         Product.is_available_today.is_(True)))
        print(f"\nготово. Активных с флагом:   {now_with_flag}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
