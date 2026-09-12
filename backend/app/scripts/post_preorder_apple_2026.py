"""Пост в канал о предзаказе линейки Apple, сентябрь 2026.

Разовый скрипт, но идемпотентный: пост живёт под стабильным slug'ом, и
повторный запуск не публикует дубль, а правит то же сообщение на том же
message_id (так устроен весь канал, см. docs/context/channel-posts.md).

Почему картинка копируется в загрузки, а не берётся из `frontend/public`.
Telegram отказывается сам скачивать медиа с нашего домена (`*.sslip.io` не в
его белом списке) — подтверждено A/B-тестом на живом канале. Наши загрузки
(`/api/uploads/...`) уходят multipart-байтами и принимаются мгновенно, а
статика фронтенда до бэкенда вообще не достаёт: это разные контейнеры.
Поэтому кадр лежит рядом со скриптом (`data/`, попадает в образ бэкенда через
`COPY app ./app`) и один раз копируется в загрузки.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.post_preorder_apple_2026 --confirm
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from app.core.uploads import save_image
from app.db.session import SessionLocal
from app.models.post import ChannelPost
from app.services import price_channel
from app.services.info_posts import INFO_KIND

SLUG = "info_preorder_apple_2026"
GROUP = "apple-sept-2026"
IMAGE = Path(__file__).with_name("data") / "apple-sept-2026-post.webp"

TITLE = "Предзаказ Apple, сентябрь 2026"

#: Текст в HTML parse mode. Списки собраны символом «•»: <ul> Telegram в
#: обычных постах не поддерживает.
#:
#: Цен здесь нет НАМЕРЕННО, и это сказано вслух в последнем абзаце. На экране
#: события цена скрыта через price_note; пост, назвавший цифру, противоречил бы
#: приложению, и человек пришёл бы за ценой, которой там нет.
#:
#: Автономности Ultra 4 в часах тоже нет: цифры стоят на карточке товара, но
#: первоисточником не подтверждены. В канал — только то, что проверено.
BODY = (
    "🍎 <b>APPLE, СЕНТЯБРЬ 2026 — ПРЕДЗАКАЗ ОТКРЫТ</b>\n"
    "\n"
    "9 сентября Apple показала новое поколение. Шесть устройств уже можно "
    "забронировать у нас — до того, как они приедут в розницу.\n"
    "\n"
    "<b>18 сентября:</b>\n"
    "• <b>iPhone 18 Pro</b> и <b>Pro Max</b> — переменная диафрагма основной "
    "камеры, чип A20 Pro, четыре цвета: burgundy, glacier, silver, black\n"
    "• <b>Apple Watch Series 12</b> — керамические корпуса\n"
    "• <b>Apple Watch Ultra 4</b> — 49 мм, чёрный титан\n"
    "• <b>AirPods 5</b> — шумоподавление в открытой посадке\n"
    "\n"
    "<b>23 октября:</b>\n"
    "• <b>iPhone Duo</b> — первый складной iPhone: 5,4″ снаружи, 7,6″ внутри\n"
    "\n"
    "<b>Как работает бронь.</b> Она ни к чему не обязывает и не требует "
    "предоплаты. Вы оставляете заявку, менеджер связывается, называет цену "
    "и срок — решаете уже тогда.\n"
    "\n"
    "Цен в посте нет намеренно: поставка и курс ещё не закрепились, "
    "а названная сегодня цифра к 18 сентября стала бы неправдой."
)

#: Кнопки хранятся ОПИСАНИЕМ, а не готовыми URL: ссылка менеджера живёт в
#: настройках, а диплинк зависит от имени бота и короткого имени Mini App.
BUTTONS = [
    {"text": "📦 Открыть предзаказ", "kind": "preorder", "value": GROUP, "row": 0},
    {"text": "🛍 Каталог", "kind": "catalog", "row": 1},
    {"text": "💬 Менеджер", "kind": "manager", "row": 1},
]

#: Предел Telegram на подпись к фото. Считается по тексту БЕЗ разметки —
#: теги уезжают в entities и в лимит не входят.
CAPTION_LIMIT = 1024


def plain_length(html: str) -> int:
    return len(re.sub(r"<[^>]+>", "", html))


def prepare(db) -> tuple[ChannelPost, list[str]]:
    """Заводит или обновляет строку поста. Возвращает её и список изменений."""
    changed: list[str] = []
    row = db.query(ChannelPost).filter_by(slug=SLUG).one_or_none()
    if row is None:
        row = ChannelPost(slug=SLUG, kind=INFO_KIND, sort_order=100)
        db.add(row)
        changed.append("создан черновик")

    if row.title != TITLE:
        row.title = TITLE
        changed.append("заголовок")
    if row.body != BODY:
        row.body = BODY
        changed.append("текст")
        # Пост уже в канале, а текст поменялся — пометим устаревшим, чтобы это
        # было видно в админке так же, как у остальных инфо-постов.
        if row.telegram_message_id:
            row.status = "outdated"
    if row.button_spec != BUTTONS:
        row.button_spec = BUTTONS
        changed.append("кнопки")

    # Картинку кладём в загрузки ОДИН раз: save_image даёт каждому вызову новое
    # имя, и без этой проверки каждый прогон плодил бы копию кадра на диске.
    if not row.image_url:
        row.image_url = save_image("image/webp", IMAGE.read_bytes())
        changed.append(f"картинка загружена: {row.image_url}")

    db.flush()
    return row, changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true",
                        help="опубликовать (без него — только показать план)")
    args = parser.parse_args()
    dry_run = not args.confirm

    length = plain_length(BODY)
    print(f"длина подписи: {length} из {CAPTION_LIMIT}")
    if length > CAPTION_LIMIT:
        print("!! подпись длиннее предела Telegram — пост не уйдёт, сократите текст")
        return 1
    if not IMAGE.is_file():
        print(f"!! нет файла картинки: {IMAGE}")
        return 1

    db = SessionLocal()
    try:
        row, changed = prepare(db)
        print("изменения:", ", ".join(changed) if changed else "нет")
        print("в канале:", f"message_id={row.telegram_message_id}"
              if row.telegram_message_id else "ещё не публиковался")

        if not dry_run:
            db.commit()

        result = price_channel.apply_info_posts(db, slugs=[SLUG], dry_run=dry_run)
        print("создано: ", result.created)
        print("обновлено:", result.updated)
        print("без измен:", result.unchanged)
        print("ошибки:   ", result.failed)

        if dry_run:
            db.rollback()
            print("\nЭто предпросмотр: в канал ничего не ушло, база не изменена.\n"
                  "Для публикации добавьте --confirm.")
        return 1 if result.failed else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
