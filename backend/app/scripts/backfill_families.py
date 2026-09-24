"""Записать в товары семейство и оси варианта (services/family_rules).

Заполняет ТОЛЬКО пустые `family_key`/`variant`: что уже сохранено (в том
числе поправлено руками в админке), не трогает. Без --confirm — предпросмотр:
какие модели получились и сколько в каждой вариантов.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.backfill_families --confirm
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter

from app.db.session import SessionLocal
from app.models.product import Product
from app.services.family_rules import resolve


def backfill(db, *, dry_run: bool) -> Counter:
    """Возвращает {семейство: сколько товаров записано}."""
    written: Counter = Counter()
    rows = (db.query(Product)
            .filter(Product.family_key.is_(None))
            .order_by(Product.id).all())
    for row in rows:
        got = resolve(row)
        if got is None:
            continue
        written[got.family] += 1
        if not dry_run:
            row.family_key = got.family
            row.variant = got.variant
    if not dry_run:
        db.flush()
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    db = SessionLocal()
    try:
        written = backfill(db, dry_run=not args.confirm)
        for family, count in written.most_common():
            print(f"{count:4}  {family}")
        print(f"\nмоделей: {len(written)}, товаров: {sum(written.values())}")
        if args.confirm:
            db.commit()
            print("записано")
        else:
            db.rollback()
            print("предпросмотр, для записи — --confirm")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
