"""Привязать карточки к строкам BSA (разово; повторный запуск ничего не ломает).

    python -m app.scripts.seed_price_links            # предпросмотр
    python -m app.scripts.seed_price_links --confirm
"""
import argparse
import sys
from pathlib import Path

from app.db.session import SessionLocal
from app.models import price_ref as _price_ref  # noqa: F401 — таблицы
from app.services import price_sync

TSV = Path(__file__).resolve().parent / "data" / "bsa_links_2026_10_06.tsv"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    with SessionLocal() as db:
        stats = price_sync.seed_links(db, TSV)
        print("привязано:", stats)
        if args.confirm:
            db.commit()
        else:
            db.rollback()
            print("предпросмотр — для записи добавьте --confirm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
