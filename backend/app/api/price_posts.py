"""Админский API постоянных прайс-постов канала (v5.6.0).

Ни один маршрут не отправляет в Telegram ничего без явного confirm=true в теле
запроса — превью и diff считаются без подтверждения, публикация и
редактирование только с ним. Это то же правило, что и у обычных постов
(см. api/posts.py), просто здесь цена ошибки выше: посты постоянные.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.audit import AuditLog
from app.models.post import ChannelPost
from app.services import price_channel
from app.services.info_posts import INFO_BY_SLUG, INFO_KIND, has_placeholders
from app.services.price_posts import NAVIGATION_SLUG, SECTIONS
from app.services.telegram_publisher import TelegramPublishError, TelegramRateLimited

router = APIRouter(prefix="/admin/price-posts", tags=["admin:price-posts"],
                   dependencies=[Depends(get_current_admin)])


class InfoTextRequest(BaseModel):
    """Правка поста: текст и/или кнопки. Не переданное поле не трогаем."""
    title: str | None = None
    body: str | None = None
    buttons: list[dict] | None = None


class CreatePostRequest(BaseModel):
    slug: str
    title: str
    body: str
    buttons: list[dict] | None = None


class ConfirmRequest(BaseModel):
    confirm: bool = False
    dry_run: bool = False
    slugs: list[str] | None = None


def _audit(db: Session, admin: str, action: str, detail: str) -> None:
    db.add(AuditLog(actor=admin, action=action, detail=detail[:500]))


def _out(row: ChannelPost) -> dict:
    return {
        "slug": row.slug,
        "title": row.title,
        "status": row.status,
        "kind": row.kind,
        "telegram_message_id": row.telegram_message_id,
        "channel_id": row.channel_id,
        "item_count": row.item_count,
        "last_generated_at": row.last_generated_at.isoformat() if row.last_generated_at else None,
        "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "published_at": row.published_at.isoformat() if row.published_at else None,
        "last_error": row.last_error,
        "length": len(row.body or ""),
        "sort_order": row.sort_order,
        "body": row.body if row.kind == INFO_KIND else None,
        "buttons": row.button_spec if row.kind == INFO_KIND else None,
        "has_placeholders": has_placeholders(row.body) if row.kind == INFO_KIND else False,
        "editable": row.kind == INFO_KIND,
        # Есть ли для поста заготовка в коде — от этого зависит, показывать ли
        # «вернуть заготовку». У постов, созданных в админке, её нет.
        "has_draft": row.slug in INFO_BY_SLUG,
    }


@router.get("")
def list_price_posts(db: Session = Depends(get_db)):
    """Список прайс-постов + разделы, которых ещё нет в БД."""
    rows = db.query(ChannelPost).filter(
        ChannelPost.kind.in_([price_channel.PRICE_KIND, price_channel.NAVIGATION_KIND])
    ).order_by(ChannelPost.sort_order).all()
    known = {row.slug for row in rows}
    return {
        "posts": [_out(row) for row in rows],
        "missing_sections": [
            {"slug": s.slug, "title": s.title} for s in SECTIONS if s.slug not in known
        ],
        "channel_id": price_channel.channel_id() or None,
        "navigation_slug": NAVIGATION_SLUG,
    }


@router.post("/info/generate")
def generate_info(db: Session = Depends(get_db), admin: str = Depends(get_current_admin)):
    """Создать черновики инфо-постов из заготовок. Написанное не затирает."""
    created = price_channel.ensure_info_drafts(db)
    _audit(db, admin, "info_posts_generated", f"{len(created)}")
    db.commit()
    return {"created": [row.slug for row in created]}


@router.get("/info/button-kinds")
def button_kinds():
    """Справочник типов кнопок для конструктора в админке."""
    from app.services.info_posts import BUTTON_KIND_LABELS

    return {
        "kinds": [{"kind": k, "label": v} for k, v in BUTTON_KIND_LABELS.items()],
        "sections": [{"slug": s.slug, "title": s.title} for s in SECTIONS],
    }


@router.post("/info")
def create_info(payload: CreatePostRequest, db: Session = Depends(get_db),
                admin: str = Depends(get_current_admin)):
    """Создать свой пост канала (текст + кнопки). Публикацию не выполняет."""
    from app.services.info_posts import DEFAULT_BUTTONS

    slug = payload.slug.strip().lower().replace(" ", "_")
    if not slug or not slug.replace("_", "").isalnum():
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Идентификатор: латиница, цифры и подчёркивание")
    if db.query(ChannelPost).filter_by(slug=slug).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Пост с таким идентификатором уже есть")
    last = db.query(ChannelPost).filter_by(kind=INFO_KIND).count()
    row = ChannelPost(
        slug=slug, kind=INFO_KIND, status="draft", title=payload.title,
        body=payload.body, button_spec=payload.buttons or list(DEFAULT_BUTTONS),
        sort_order=2000 + last,
    )
    db.add(row)
    _audit(db, admin, "info_post_created", slug)
    db.commit()
    db.refresh(row)
    return _out(row)


@router.patch("/info/{slug}")
def edit_info(slug: str, payload: InfoTextRequest, db: Session = Depends(get_db),
              admin: str = Depends(get_current_admin)):
    """Изменить текст и кнопки поста. В канал само по себе не уходит."""
    row = db.query(ChannelPost).filter_by(slug=slug, kind=INFO_KIND).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инфо-пост не найден")
    if payload.title is not None:
        row.title = payload.title
    if payload.body is not None:
        row.body = payload.body
    if payload.buttons is not None:
        row.button_spec = payload.buttons
    if row.telegram_message_id:
        row.status = "outdated"
    _audit(db, admin, "info_post_edited", slug)
    db.commit()
    db.refresh(row)
    return _out(row)


@router.post("/info/{slug}/reset")
def reset_info(slug: str, db: Session = Depends(get_db),
               admin: str = Depends(get_current_admin)):
    """Вернуть посту заготовку из кода. В канал само по себе не уходит.

    Заготовки намеренно не перезаписывают текст, который уже лежит в базе:
    инфо-пост пишет человек, и генерация не вправе затирать его правки
    (см. price_channel.ensure_info_drafts). Но когда заготовку в коде
    переписали — например, условия магазина наконец назвали, — вернуть её
    было нечем: оставался копипаст HTML в текстовое поле, где разметку легко
    сломать. Эта ручка и есть явное «да, возьми версию из кода».

    Работает только для разделов, у которых заготовка есть. Свои посты,
    созданные в админке, возвращать не к чему — им отвечаем 404.
    """
    draft = INFO_BY_SLUG.get(slug)
    if draft is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "У этого поста нет заготовки в коде")
    row = db.query(ChannelPost).filter_by(slug=slug, kind=INFO_KIND).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инфо-пост не найден")

    row.title = draft.title
    row.body = draft.default_text
    # Опубликованный пост расходится с каналом до повторной отправки — тот же
    # признак, что ставит ручное редактирование.
    if row.telegram_message_id:
        row.status = "outdated"
    _audit(db, admin, "info_post_reset", slug)
    db.commit()
    db.refresh(row)
    return _out(row)


@router.post("/info/publish")
def publish_info(payload: ConfirmRequest, db: Session = Depends(get_db),
                 admin: str = Depends(get_current_admin)):
    """Опубликовать или обновить инфо-посты (только с подтверждением)."""
    if not payload.dry_run and not payload.confirm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Требуется явное подтверждение публикации")
    try:
        result = price_channel.apply_info_posts(db, slugs=payload.slugs,
                                                dry_run=payload.dry_run)
    except TelegramRateLimited as exc:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(exc)) from exc
    except TelegramPublishError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    if not payload.dry_run:
        _audit(db, admin, "info_posts_published",
               f"created={len(result.created)} updated={len(result.updated)}")
        db.commit()
    return {
        "dry_run": payload.dry_run,
        "created": result.created, "updated": result.updated,
        "unchanged": result.unchanged,
        "failed": [{"slug": s, "error": e} for s, e in result.failed],
    }


@router.get("/plan")
def plan(db: Session = Depends(get_db)):
    """Что изменится, если применить обновление. Ничего не отправляет."""
    plans = price_channel.build_plan(db)
    return {
        "generated_for": date.today().isoformat(),
        "summary": {
            "create": sum(1 for p in plans if p.action == "create"),
            "update": sum(1 for p in plans if p.action == "update"),
            "unchanged": sum(1 for p in plans if p.action == "unchanged"),
            "over_limit": sum(1 for p in plans if p.over_limit),
        },
        "posts": [{
            "slug": p.slug,
            "section_slug": p.section_slug,
            "title": p.title,
            "action": p.action,
            "message_id": p.message_id,
            "item_count": p.item_count,
            "length": p.length,
            "over_limit": p.over_limit,
            "price_changes": [
                {"name": name, "old": old, "new": new} for name, old, new in p.price_changes
            ],
            "added": p.added,
            "removed": p.removed,
        } for p in plans],
    }


@router.get("/{slug}/preview")
def preview_one(slug: str, db: Session = Depends(get_db)):
    for p in price_channel.build_plan(db):
        if p.slug == slug:
            return {"slug": p.slug, "text": p.text, "keyboard": p.keyboard,
                    "length": p.length, "over_limit": p.over_limit,
                    "item_count": p.item_count, "action": p.action}
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Раздел не найден")


@router.post("/generate")
def generate(db: Session = Depends(get_db), admin: str = Depends(get_current_admin)):
    """«Сформировать все прайсы из каталога» — только черновики, без публикации."""
    rows = price_channel.save_preview(db)
    _audit(db, admin, "price_posts_generated", f"{len(rows)}")
    db.commit()
    return {"generated": len(rows), "posts": [_out(row) for row in rows]}


def _apply(db: Session, admin: str, payload: ConfirmRequest, action: str):
    if not payload.dry_run and not payload.confirm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Требуется явное подтверждение публикации")
    try:
        if action == "navigation":
            result = price_channel.sync_navigation(db, dry_run=payload.dry_run)
        else:
            result = price_channel.apply_plan(db, slugs=payload.slugs, dry_run=payload.dry_run)
    except TelegramRateLimited as exc:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(exc)) from exc
    except TelegramPublishError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    if not payload.dry_run:
        _audit(db, admin, f"price_posts_{action}",
               f"created={len(result.created)} updated={len(result.updated)}")
        db.commit()
    return {
        "dry_run": payload.dry_run,
        "created": result.created,
        "updated": result.updated,
        "unchanged": result.unchanged,
        "failed": [{"slug": s, "error": e} for s, e in result.failed],
        "navigation_message_id": result.navigation_message_id,
    }


@router.post("/publish")
def publish(payload: ConfirmRequest, db: Session = Depends(get_db),
            admin: str = Depends(get_current_admin)):
    """Опубликовать недостающие и обновить изменившиеся посты."""
    return _apply(db, admin, payload, "publish")


@router.post("/navigation")
def update_navigation(payload: ConfirmRequest, db: Session = Depends(get_db),
                      admin: str = Depends(get_current_admin)):
    """Создать навигационный пост или обновить только его клавиатуру."""
    return _apply(db, admin, payload, "navigation")
