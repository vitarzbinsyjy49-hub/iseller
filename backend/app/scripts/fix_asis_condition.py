"""Перевести уже заведённые ASIS-позиции в condition=showcase.

До исправления импорта (scripts/import_bsa.py, `catalog_condition`) пометка
ASIS из прайса BSA попадала только в название («… Orange [ASIS]») и в артикул
(«…-ASIS», «…-ASIS-ACT»), а condition оставался new. Из-за этого фильтр
«только новые» в каталоге и ИИ-подборе отдавал витринные образцы как новые.

Трогаем только condition=new (и пустой): если владелец руками поставил
карточке другое состояние, скрипт его не перетирает.

Правило `dry-run -> confirm`, как везде в проекте: без --confirm ничего не
меняется.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.fix_asis_condition
    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.fix_asis_condition --confirm
"""
from __future__ import annotations

import argparse
import re

from sqlalchemy import or_

from app.db.session import SessionLocal
from app.models.product import CONDITION_SHOWCASE, Product

#: Отдельным словом: «Basis» в названии чехла — не пометка.
_ASIS = re.compile(r"\bASIS\b", re.I)


def find_asis(db) -> list[Product]:
    """Карточки с пометкой ASIS, которые всё ещё числятся новыми."""
    rough = (db.query(Product)
             .filter(or_(Product.condition == "new", Product.condition.is_(None)))
             .filter(or_(Product.title.ilike("%asis%"), Product.sku.ilike("%asis%")))
             .order_by(Product.id)
             .all())
    return [p for p in rough if _ASIS.search(p.title or "") or _ASIS.search(p.sku or "")]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true",
                        help="Записать изменения. Без флага — сухой прогон")
    args = parser.parse_args(argv)

    db = SessionLocal()
    try:
        rows = find_asis(db)
        print(f"ASIS с condition=new: {len(rows)}")
        for p in rows:
            state = "активна" if p.is_active else "скрыта"
            print(f"  {p.id:>6}  {p.sku:36} {state:8} {(p.title or '')[:70]}")

        if not args.confirm:
            print("\nСухой прогон. Чтобы применить — повторить с --confirm.")
            return 0

        for p in rows:
            p.condition = CONDITION_SHOWCASE
        db.commit()
        print(f"\nпереведено в {CONDITION_SHOWCASE}: {len(rows)}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
