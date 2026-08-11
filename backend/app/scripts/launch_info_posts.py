"""Разовая подготовка и публикация инфо-постов к запуску (11.08.2026).

Зачем отдельный скрипт. Обычный поток делает то же самое кнопками в админке,
но здесь операций много и порядок между ними жёсткий: сначала тексты, потом
публикация разделов, и только последней — навигация, потому что кнопка на
раздел появляется лишь у поста с message_id. Пройти это руками, ничего не
перепутав, можно; повторить в том же порядке через месяц — уже вряд ли.

Что делает:
  1. создаёт недостающие черновики (появляется «Обмен и возврат»);
  2. возвращает заготовки из кода тем разделам, чей текст в базе устарел, —
     это те, что писались, когда условий магазина проект ещё не знал и часть
     строк была помечена «[уточнить]»;
  3. переписывает два поста, у которых заготовки в коде нет: закреп каталога
     и анонс запуска (в них же меняется имя «AI Seller» на «АйСеллер»);
  4. публикует разделы — новые отправляет, изменённые правит на том же
     message_id, поэтому у подписчиков ничего не всплывает;
  5. обновляет навигационный пост.

Чего НЕ делает: не трогает info_warranty. Его текст поправлен руками в
админке и уже говорит «Гарантия 1 месяц» — заготовка не даст ему ничего, а
перезапись чужой правки как побочный эффект скрипта недопустима.

Идемпотентен: повторный запуск заново ничего не публикует, потому что
apply_info_posts правит существующие сообщения, а не создаёт новые.

    docker compose -f docker-compose.prod.yml exec -T backend \\
        python -m app.scripts.launch_info_posts --confirm
"""
from __future__ import annotations

import argparse
import sys

from app.db.session import SessionLocal
from app.models.post import ChannelPost
from app.services import price_channel
from app.services.info_posts import INFO_BY_SLUG, INFO_KIND, has_placeholders

#: Разделы, которым возвращаем заготовку из кода. info_warranty здесь нет
#: намеренно — см. модульную строку документации.
RESET_SLUGS = ("info_about", "info_delivery", "info_payment", "info_preorder")

#: Посты, созданные когда-то в админке: заготовки в коде у них нет, поэтому
#: текст задаётся здесь. Имя магазина в обоих приводится к «АйСеллер».
CUSTOM_POSTS: dict[str, tuple[str, str]] = {
    "info_pin_catalog": (
        "Закреп: открыть каталог",
        "🛍 <b>АЙСЕЛЛЕР</b>\n"
        "Техника Apple, Dyson и PlayStation по актуальным ценам — каталог, "
        "фото и характеристики в приложении.\n"
        "\n"
        "Гарантия 1 месяц, проверка при вас, самовывоз с Горбушки "
        "и доставка по России.",
    ),
    "info_launch": (
        "Запуск бота 11.08.2026",
        "🚀 <b>ЗАПУСК 11 АВГУСТА</b>\n"
        "\n"
        "С 11.08.2026 АйСеллер открыт для заказов прямо в Telegram — "
        "без сайтов и звонков.\n"
        "\n"
        "• каталог с фото, характеристиками и ценами из наличия;\n"
        "• AI-подбор: опишите задачу и бюджет — предложит варианты;\n"
        "• заявка в приложении, дальше с вами общается менеджер.\n"
        "\n"
        "Гарантия 1 месяц, технику проверяем вместе до оплаты. "
        "Самовывоз — Горбушка, Москва, 10:00–21:00. Доставка курьером "
        "по Москве и СДЭК по России, оплата наличными при получении.\n"
        "\n"
        "Приложение в бета-версии и продолжает развиваться — магазин "
        "при этом работает по-настоящему.",
    ),
}

#: Что публикуем и в каком порядке. Порядок определяет, как разделы лягут
#: в канале и в клавиатуре навигатора.
PUBLISH_SLUGS = (
    "info_about", "info_delivery", "info_payment",
    "info_warranty", "info_returns", "info_preorder",
    "info_pin_catalog", "info_launch",
)


def prepare(db) -> list[str]:
    """Шаги 1–3: тексты. Возвращает список того, что изменилось.

    Новые тексты ставятся на объекты сессии ВСЕГДА, даже в предпросмотре, и
    фиксируются коммитом только по --confirm (иначе вызывающий делает
    rollback). Иначе предпросмотр врёт: проверка «[уточнить]» и сравнение с
    опубликованным читали бы старые тексты и обещали пропустить как раз те
    посты, ради которых всё и затевалось.
    """
    changed: list[str] = []

    created = price_channel.ensure_info_drafts(db)
    changed += [f"создан черновик {row.slug}" for row in created]

    rows = {row.slug: row for row in db.query(ChannelPost).filter_by(kind=INFO_KIND).all()}

    def rewrite(slug: str, title: str, body: str, reason: str) -> None:
        row = rows.get(slug)
        if row is None or (row.body == body and row.title == title):
            return
        row.title = title
        row.body = body
        if row.telegram_message_id:
            row.status = "outdated"
        changed.append(f"{reason}: {slug}")

    for slug in RESET_SLUGS:
        draft = INFO_BY_SLUG.get(slug)
        if draft is not None:
            rewrite(slug, draft.title, draft.default_text, "заготовка возвращена")

    for slug, (title, body) in CUSTOM_POSTS.items():
        rewrite(slug, title, body, "текст переписан")

    db.flush()
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true",
                        help="выполнить публикацию (без него — только показать план)")
    args = parser.parse_args()
    dry_run = not args.confirm

    db = SessionLocal()
    try:
        print("== 1-3. Тексты ==")
        for line in prepare(db) or ["изменений нет"]:
            print("  ", line)
        if not dry_run:
            db.commit()

        # Пост с незаполненным местом система публиковать откажется — но лучше
        # увидеть это списком до отправки, чем в отчёте об ошибках после.
        blocked = [
            row.slug
            for row in db.query(ChannelPost).filter_by(kind=INFO_KIND).all()
            if row.slug in PUBLISH_SLUGS and has_placeholders(row.body)
        ]
        if blocked:
            print("\n!! незаполненные места, публикация пропустит:", ", ".join(blocked))

        print("\n== 4. Публикация разделов ==")
        slugs = [s for s in PUBLISH_SLUGS if s not in blocked]
        result = price_channel.apply_info_posts(db, slugs=slugs, dry_run=dry_run)
        print("   создано: ", result.created)
        print("   обновлено:", result.updated)
        print("   без измен:", result.unchanged)
        print("   ошибки:   ", result.failed)

        print("\n== 5. Навигация ==")
        nav = price_channel.sync_navigation(db, dry_run=dry_run)
        print("   создано: ", nav.created)
        print("   обновлено:", nav.updated)
        print("   без измен:", nav.unchanged)
        print("   ошибки:   ", nav.failed)

        if dry_run:
            # Тексты стояли на объектах сессии ради честного предпросмотра —
            # снимаем их, чтобы предпросмотр остался предпросмотром.
            db.rollback()
            print("\nЭто был предпросмотр: в канал ничего не ушло, тексты в базе "
                  "не изменены. Недостающие черновики при этом создаются — "
                  "ensure_info_drafts коммитит сам, и это безвредно: черновик "
                  "без публикации никому не виден.\n"
                  "Для выполнения добавьте --confirm.")
        return 1 if (result.failed or nav.failed) else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
