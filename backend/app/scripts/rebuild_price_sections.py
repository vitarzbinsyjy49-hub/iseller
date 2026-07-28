"""Разовая перестройка структуры разделов прайса (v5.6.1).

Зачем нужен отдельный скрипт. Обычный поток умеет создавать и редактировать
посты, но не умеет их удалять — намеренно: удаление сообщения необратимо и не
должно случаться по кнопке. А здесь три раздела Dyson (волосы / пылесосы /
климат) схлопываются в один, и два лишних сообщения обязаны исчезнуть из
канала, иначе они останутся висеть без единой ссылки из навигации.

Что делает:
  1. переносит message_id первого из старых Dyson-постов на новый slug
     price_dyson — так объединённый раздел ЗАНИМАЕТ уже существующее
     сообщение, а не публикуется заново поверх старых;
  2. удаляет из канала оставшиеся Dyson-посты и их строки в БД;
  3. обновляет тексты всех разделов (формат с флагами);
  4. пересобирает клавиатуру навигационного поста.

Идемпотентен: повторный запуск, когда переезд уже сделан, ничего не удаляет и
не публикует.

    docker compose -f docker-compose.prod.yml exec -T backend \
        python -m app.scripts.rebuild_price_sections --confirm
"""
from __future__ import annotations

import argparse
import io
import sys

from app.db.session import SessionLocal
from app.models.post import ChannelPost
from app.services import price_channel
from app.services.telegram_publisher import delete_message

#: Старые слаги в порядке приоритета: чей message_id унаследует price_dyson.
LEGACY_DYSON = ("price_dyson_hair", "price_dyson_vacuum", "price_dyson_climate")
NEW_DYSON = "price_dyson"


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    parser = argparse.ArgumentParser(description="Перестроить разделы прайса")
    parser.add_argument("--confirm", action="store_true",
                        help="выполнить (без флага — только показать план)")
    args = parser.parse_args()

    with SessionLocal() as db:
        rows = {r.slug: r for r in db.query(ChannelPost).filter(
            ChannelPost.slug.in_([*LEGACY_DYSON, NEW_DYSON])).all()}

        heir = next((rows[slug] for slug in LEGACY_DYSON
                     if slug in rows and rows[slug].telegram_message_id), None)
        doomed = [rows[slug] for slug in LEGACY_DYSON
                  if slug in rows and rows[slug] is not heir]

        if NEW_DYSON in rows:
            print(f"раздел {NEW_DYSON} уже существует "
                  f"(message_id={rows[NEW_DYSON].telegram_message_id}) — переезд не нужен")
        elif heir is None:
            print("старых Dyson-постов нет — переезжать нечего")
        else:
            print(f"переезд: {heir.slug} (message_id={heir.telegram_message_id}) -> {NEW_DYSON}")
            for row in doomed:
                print(f"удалить из канала: {row.slug} (message_id={row.telegram_message_id})")
            if args.confirm:
                heir.slug = NEW_DYSON
                heir.title = "Dyson"
                db.commit()
                for row in doomed:
                    if row.telegram_message_id:
                        deleted = delete_message(message_id=row.telegram_message_id,
                                                 channel_id=price_channel.channel_id())
                        print(f"  {row.slug}: удалено={deleted}")
                    db.delete(row)
                db.commit()

        print()
        plan = price_channel.build_plan(db)
        for item in plan:
            print(f"  {item.slug:22} {item.action:9} товаров={item.item_count:3} "
                  f"длина={item.length:5}" + ("  ПРЕВЫШЕН ЛИМИТ" if item.over_limit else ""))

        if not args.confirm:
            print("\n(без --confirm ничего не отправлено)")
            return 0

        result = price_channel.apply_plan(db)
        print(f"\nсоздано: {result.created}")
        print(f"обновлено: {result.updated}")
        print(f"без изменений: {len(result.unchanged)}")
        for slug, error in result.failed:
            print(f"  ОШИБКА {slug}: {error}")

        nav = price_channel.sync_navigation(db)
        print(f"навигация: создано={nav.created} обновлено={nav.updated} ошибки={nav.failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
