"""Пересчитать Product.popularity из реальных просмотров (product_view).

Без этого шага popularity нулевая у всех, и `ORDER BY popularity DESC` в
services/ranking.py вырождается: решение переходит к позиции категории на
главной, а там смартфонов физически больше всего — «Популярное» превращается
в «сначала все смартфоны», не потому что их смотрят чаще, а просто потому что
их больше в каталоге.

Источник и почему ему можно верить (или скорее — почему здесь можно то, что
нельзя в services/social_proof.py) — см. docstring services/ranking.view_counts.

Идемпотентен: каждый прогон целиком пересчитывает значение по окну
VIEW_WINDOW_DAYS, поэтому старые просмотры со временем сами выпадают из
счёта — отдельной ручки «забыть» не нужно. Расписания (cron) на сервере нет,
прогонять нужно вручную по мере накопления новых просмотров.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.recompute_popularity --confirm
"""
from __future__ import annotations

import argparse

from app.db.session import SessionLocal
from app.models.product import Product
from app.services.ranking import VIEW_WINDOW_DAYS, view_counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    dry_run = not args.confirm

    db = SessionLocal()
    try:
        counts = view_counts(db, window_days=VIEW_WINDOW_DAYS)
        products = db.query(Product).filter(Product.is_active.is_(True)).all()

        changed = 0
        for product in products:
            new_value = float(counts.get(product.id, 0))
            if float(product.popularity or 0) != new_value:
                changed += 1
                if not dry_run:
                    product.popularity = new_value

        print(f"окно: {VIEW_WINDOW_DAYS} дн., товаров: {len(products)}, "
              f"с просмотрами: {len(counts)}, изменится: {changed}")

        if dry_run:
            db.rollback()
            print("\nЭто предпросмотр. Для выполнения добавьте --confirm.")
        else:
            db.commit()
            print("готово.")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
