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
счёта — отдельной ручки «забыть» не нужно. С 04.10.2026 тот же пересчёт
(services/ranking.recompute_popularity) раз в сутки делает цикл бота; скрипт
остался для ручного прогона и предпросмотра.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.recompute_popularity --confirm
"""
from __future__ import annotations

import argparse

from app.db.session import SessionLocal
from app.services.ranking import VIEW_WINDOW_DAYS, recompute_popularity


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    dry_run = not args.confirm

    db = SessionLocal()
    try:
        changed = recompute_popularity(db, dry_run=dry_run)
        print(f"окно: {VIEW_WINDOW_DAYS} дн., изменится: {changed}")
        if dry_run:
            print("\nЭто предпросмотр. Для выполнения добавьте --confirm.")
        else:
            print("готово.")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
