"""Сверка по тексту постов BSA, снятому вручную (rich-посты: iPhone, Watch S11, стайлеры).

Файл: блоки «### <id поста>», под ними строки прайса как есть. Делает то же,
что ежедневная сверка: цены BSA − 500 (крупные — на подтверждение), отчёт
админам, сразу правка прайса в группе.

    python -m app.scripts.ingest_bsa_text data/bsa_rich_2026_10_09.txt            # предпросмотр
    python -m app.scripts.ingest_bsa_text data/bsa_rich_2026_10_09.txt --confirm
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.db.session import SessionLocal
from app.services import daily_bsa_check, daily_price_sync, price_sync


def read_blocks(path: Path) -> dict[int, str]:
    blocks: dict[int, list[str]] = {}
    current = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("### "):
            current = int(line[4:].strip())
            continue
        blocks.setdefault(current, []).append(line)
    return {k: "\n".join(v) for k, v in blocks.items()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    path = Path(args.file)
    if not path.is_absolute():
        path = Path(__file__).resolve().parent / path
    texts = read_blocks(path)
    with SessionLocal() as db:
        if not args.confirm:
            for post_id, text in texts.items():
                price_sync.ingest_text(db, text, post_id=post_id)
            diffs, stats = price_sync.discrepancies(db)
            print(stats)
            for d in diffs[:60]:
                print(f"{d.title[:55]:<55} {d.our_price:>8} -> {d.ref.suggested:>8} {d.delta:+}")
            db.rollback()
            print("предпросмотр — для применения добавьте --confirm")
            return 0
        print("сверка:", daily_bsa_check.run(db, texts=texts, failed=[], origin="manual-text"))
        print("группа:", daily_price_sync.run(db, mark=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
