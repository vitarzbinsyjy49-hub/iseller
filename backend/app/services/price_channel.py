"""Оркестрация прайс-постов канала (v5.6.0): каталог → БД → Telegram.

Разделение ответственности:
  price_posts.py       — чистая генерация текста и клавиатур (без сети и БД);
  telegram_publisher.py— отправка/редактирование с retry и 429;
  этот модуль          — состояние: что уже опубликовано, что изменилось,
                         что нужно создать, а что отредактировать.

Два правила, вокруг которых всё построено:

1. Публикация и редактирование НИКОГДА не происходят без явного confirm от
   администратора. Всё, что можно сделать без подтверждения, — посчитать
   превью и diff.
2. При частичной ошибке уже полученные message_id обязаны сохраниться. Пачка
   из десяти постов может упереться в лимит Telegram на середине; если
   потерять id опубликованных, следующий прогон выложит их заново и в канале
   появятся дубли. Поэтому каждый пост фиксируется в БД сразу после успеха, а
   не одной транзакцией в конце.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.post import ChannelPost
from app.models.product import Product
from app.services.price_posts import (
    NAVIGATION_SLUG,
    SECTIONS,
    RenderedPost,
    catalog_fingerprint,
    diff_posts,
    navigation_keyboard,
    navigation_text,
    render_all,
)
from app.services.telegram_publisher import (
    TelegramPublishError,
    edit_message,
    edit_reply_markup,
    send_message,
)

logger = logging.getLogger("techshop.price")

PRICE_KIND = "price"
NAVIGATION_KIND = "price_nav"

#: Суффикс второй и следующих частей длинного раздела: price_iphone_p2.
_PART_SUFFIX = re.compile(r"_p\d+$")


def channel_id() -> str:
    return settings.TELEGRAM_CHANNEL_ID


def load_catalog(db: Session) -> list[dict]:
    """Товары для прайса — из каталога, а не из импортного файла.

    Пост обязан совпадать с тем, что покупатель видит в Mini App: если цену
    поправили в админке, прайс должен уметь обновиться без нового XLSX.
    """
    rows = db.query(Product).filter(Product.is_active.is_(True)).all()
    return [{
        "sku": p.sku, "title": p.title, "brand": p.brand,
        "category": p.category, "subcategory": p.subcategory,
        "price": float(p.price), "old_price": float(p.old_price) if p.old_price else None,
        "is_active": p.is_active, "is_hot": p.is_hot,
    } for p in rows]


def _existing(db: Session) -> dict[str, ChannelPost]:
    rows = db.query(ChannelPost).filter(
        ChannelPost.kind.in_([PRICE_KIND, NAVIGATION_KIND])).all()
    return {row.slug: row for row in rows if row.slug}


# ---------------------------------------------------------------- превью и diff

@dataclass
class PostPlan:
    """Что произойдёт с одним постом, если применить изменения."""
    slug: str
    section_slug: str
    title: str
    text: str
    item_count: int
    keyboard: list[list[dict]]
    action: str                      # create | update | unchanged
    message_id: int | None = None
    price_changes: list[tuple[str, float, float]] = field(default_factory=list)
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    over_limit: bool = False
    length: int = 0


def build_plan(db: Session, on_date: date | None = None) -> list[PostPlan]:
    """Посчитать план изменений. Ничего не отправляет и не пишет в БД."""
    on_date = on_date or date.today()
    products = load_catalog(db)
    rendered = render_all(products, on_date, settings.MINI_APP_URL,
                            settings.MANAGER_RETAIL_URL, settings.BOT_USERNAME)
    existing = _existing(db)

    plans: list[PostPlan] = []
    for post in rendered:
        current = existing.get(post.slug)
        # Diff считаем против ТЕКСТА, который лежит в канале (мы храним его
        # копию), а не против прошлой генерации: пост могли поправить руками,
        # и сравнение с собственным кэшем это скрыло бы.
        diff = diff_posts(current.body if current else "", post)
        if current is None or current.telegram_message_id is None:
            action = "create"
        elif diff.has_changes:
            action = "update"
        else:
            action = "unchanged"
        plans.append(PostPlan(
            slug=post.slug, section_slug=post.section_slug, title=post.title,
            text=post.text, item_count=post.item_count, keyboard=post.keyboard,
            action=action,
            message_id=current.telegram_message_id if current else None,
            price_changes=diff.price_changes, added=diff.added, removed=diff.removed,
            over_limit=diff.over_limit, length=len(post.text),
        ))
    return plans


def save_preview(db: Session, on_date: date | None = None) -> list[ChannelPost]:
    """Сохранить сгенерированные тексты как черновики.

    Публикацию не трогает: уже опубликованные посты сохраняют свой
    telegram_message_id и статус, меняется только заготовленный текст.
    """
    on_date = on_date or date.today()
    products = load_catalog(db)
    fingerprint = catalog_fingerprint(products)
    rendered = render_all(products, on_date, settings.MINI_APP_URL,
                            settings.MANAGER_RETAIL_URL, settings.BOT_USERNAME)
    existing = _existing(db)
    now = datetime.now(timezone.utc)
    order = {section.slug: index for index, section in enumerate(SECTIONS)}

    result: list[ChannelPost] = []
    for post in rendered:
        row = existing.get(post.slug)
        if row is None:
            row = ChannelPost(slug=post.slug, kind=PRICE_KIND, status="draft")
            db.add(row)
        row.title = post.title
        row.kind = PRICE_KIND
        row.sort_order = order.get(post.section_slug, 99) * 10 + post.part
        row.item_count = post.item_count
        row.reply_markup = post.keyboard
        row.catalog_fingerprint = fingerprint
        row.last_generated_at = now
        # Текст опубликованного поста НЕ перезаписываем: body хранит то, что
        # реально лежит в канале, и подмена сломала бы diff. Новый текст
        # применяется только в момент подтверждённого обновления.
        if row.telegram_message_id is None:
            row.body = post.text
            row.status = "draft"
        elif row.body != post.text:
            row.status = "outdated"
        result.append(row)

    db.commit()
    return result


# ---------------------------------------------------------------- применение

@dataclass
class ApplyResult:
    created: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    navigation_message_id: int | None = None


def apply_plan(
    db: Session, *, slugs: list[str] | None = None, on_date: date | None = None,
    dry_run: bool = False,
) -> ApplyResult:
    """Создать недостающие посты и обновить изменившиеся.

    dry_run проходит весь путь, кроме обращений к Telegram, — админ видит
    точный список действий до того, как что-то уйдёт в канал.
    """
    on_date = on_date or date.today()
    if not dry_run and not channel_id():
        raise TelegramPublishError("TELEGRAM_CHANNEL_ID не настроен")

    plans = build_plan(db, on_date)
    if slugs is not None:
        wanted = set(slugs)
        plans = [p for p in plans if p.slug in wanted]

    products = load_catalog(db)
    fingerprint = catalog_fingerprint(products)
    existing = _existing(db)
    now = datetime.now(timezone.utc)
    order = {section.slug: index for index, section in enumerate(SECTIONS)}
    result = ApplyResult()

    for plan in plans:
        if plan.action == "unchanged":
            result.unchanged.append(plan.slug)
            continue
        if plan.over_limit:
            result.failed.append((plan.slug, "текст превышает лимит Telegram"))
            continue
        if dry_run:
            (result.created if plan.action == "create" else result.updated).append(plan.slug)
            continue

        row = existing.get(plan.slug)
        try:
            if plan.action == "create":
                message_id = send_message(
                    text=plan.text, keyboard=plan.keyboard, channel_id=channel_id())
                if row is None:
                    row = ChannelPost(slug=plan.slug, kind=PRICE_KIND)
                    db.add(row)
                row.telegram_message_id = message_id
                row.published_at = now
                result.created.append(plan.slug)
            else:
                edit_message(message_id=row.telegram_message_id, text=plan.text,
                             keyboard=plan.keyboard, channel_id=channel_id())
                result.updated.append(plan.slug)

            row.title = plan.title
            row.body = plan.text
            row.kind = PRICE_KIND
            row.status = "published"
            row.channel_id = str(channel_id())
            row.item_count = plan.item_count
            row.reply_markup = plan.keyboard
            row.catalog_fingerprint = fingerprint
            row.sort_order = order.get(plan.section_slug, 99) * 10
            row.last_generated_at = now
            row.last_synced_at = now
            row.last_error = None
            # Фиксируем КАЖДЫЙ пост сразу: если следующий упрётся в лимит
            # Telegram, уже полученные message_id должны остаться в БД, иначе
            # повторный прогон выложит дубли в канал.
            db.commit()
        except TelegramPublishError as exc:
            db.rollback()
            # Причину сбоя фиксируем и для НОВОГО поста: до первой удачной
            # отправки строки в БД ещё нет, и без этой ветки администратор
            # увидел бы просто отсутствующий раздел без объяснения.
            row = _existing(db).get(plan.slug)
            if row is None:
                row = ChannelPost(slug=plan.slug, kind=PRICE_KIND, title=plan.title,
                                  body=plan.text, item_count=plan.item_count)
                db.add(row)
            row.status = "error"
            row.last_error = str(exc)[:500]
            db.commit()
            logger.warning("прайс-пост %s: %s", plan.slug, exc)
            result.failed.append((plan.slug, str(exc)))

    return result


def sync_navigation(db: Session, *, on_date: date | None = None, dry_run: bool = False) -> ApplyResult:
    """Создать навигационный пост или обновить его клавиатуру.

    Существующий пост НЕ публикуется заново: меняется только reply_markup,
    чтобы у подписчиков не всплывало новое сообщение и не терялся закреп.
    """
    on_date = on_date or date.today()
    result = ApplyResult()
    if not dry_run and not channel_id():
        raise TelegramPublishError("TELEGRAM_CHANNEL_ID не настроен")

    existing = _existing(db)
    published = {
        slug: row.telegram_message_id
        for slug, row in existing.items()
        if row.kind == PRICE_KIND and row.telegram_message_id
    }
    # Части длинного раздела в навигацию не выносим: она показывает разделы, а
    # не сообщения, и вторая часть лежит сразу под первой.
    # Проверяем именно СУФФИКС _p<число>, а не вхождение «_p»: подстрока «_p»
    # встречается внутри обычных слагов (price_macbook_pro, price_playstation),
    # и поиск по вхождению вычёркивал эти разделы из навигации целиком.
    published = {slug: mid for slug, mid in published.items()
                 if not _PART_SUFFIX.search(slug)}

    keyboard = navigation_keyboard(
        published, channel_id() or "@isellerhub",
        settings.MINI_APP_URL, settings.MANAGER_RETAIL_URL, settings.BOT_USERNAME)
    text = navigation_text(on_date)
    row = existing.get(NAVIGATION_SLUG)

    if dry_run:
        if row is None or row.telegram_message_id is None:
            result.created.append(NAVIGATION_SLUG)
        elif row.reply_markup != keyboard or row.body != text:
            result.updated.append(NAVIGATION_SLUG)
        else:
            result.unchanged.append(NAVIGATION_SLUG)
        return result

    now = datetime.now(timezone.utc)
    try:
        if row is None or row.telegram_message_id is None:
            message_id = send_message(text=text, keyboard=keyboard, channel_id=channel_id())
            if row is None:
                row = ChannelPost(slug=NAVIGATION_SLUG, kind=NAVIGATION_KIND)
                db.add(row)
            row.telegram_message_id = message_id
            row.published_at = now
            result.created.append(NAVIGATION_SLUG)
        else:
            if row.body != text:
                edit_message(message_id=row.telegram_message_id, text=text,
                             keyboard=keyboard, channel_id=channel_id())
            else:
                edit_reply_markup(message_id=row.telegram_message_id,
                                  keyboard=keyboard, channel_id=channel_id())
            result.updated.append(NAVIGATION_SLUG)

        row.title = "Навигация по прайсу"
        row.kind = NAVIGATION_KIND
        row.body = text
        row.reply_markup = keyboard
        row.status = "published"
        row.channel_id = str(channel_id())
        row.sort_order = -1
        row.last_generated_at = now
        row.last_synced_at = now
        row.last_error = None
        db.commit()
        result.navigation_message_id = row.telegram_message_id
    except TelegramPublishError as exc:
        db.rollback()
        logger.warning("навигационный пост: %s", exc)
        result.failed.append((NAVIGATION_SLUG, str(exc)))

    return result
