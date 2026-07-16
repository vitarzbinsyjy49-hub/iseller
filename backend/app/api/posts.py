from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.audit import AuditLog
from app.models.post import ChannelPost
from app.services.telegram_publisher import TelegramPublishError, publish_post

router = APIRouter(prefix="/admin/posts", tags=["admin-posts"], dependencies=[Depends(get_current_admin)])


class PostCreate(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=4096)
    image_url: str | None = None
    kind: str = "news"
    sources: list[str] = Field(default_factory=list)


class PostPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=240)
    body: str | None = Field(None, min_length=1, max_length=4096)
    image_url: str | None = None
    kind: str | None = None
    sources: list[str] | None = None


class PublishRequest(BaseModel):
    confirm: bool


def _out(post: ChannelPost) -> dict:
    return {
        "id": post.id, "title": post.title, "body": post.body, "image_url": post.image_url,
        "kind": post.kind, "sources": post.sources or [], "status": post.status,
        "content_version": post.content_version, "approved_version": post.approved_version,
        "telegram_message_id": post.telegram_message_id,
        "published_at": post.published_at.isoformat() if post.published_at else None,
        "created_at": post.created_at.isoformat() if post.created_at else None,
    }


def _get(db: Session, post_id: int) -> ChannelPost:
    post = db.get(ChannelPost, post_id)
    if post is None:
        raise HTTPException(404, "Post not found")
    return post


def _audit(db: Session, admin: str, action: str, post_id: int) -> None:
    db.add(AuditLog(actor=f"admin:{admin}", action=action, detail=f"post:{post_id}"))


@router.get("")
def list_posts(status_filter: str | None = None, db: Session = Depends(get_db)):
    stmt = select(ChannelPost).order_by(ChannelPost.id.desc())
    if status_filter:
        stmt = stmt.where(ChannelPost.status == status_filter)
    return {"posts": [_out(p) for p in db.execute(stmt.limit(100)).scalars()]}


@router.post("")
def create_post(payload: PostCreate, db: Session = Depends(get_db)):
    post = ChannelPost(**payload.model_dump(), status="draft")
    db.add(post)
    db.commit()
    db.refresh(post)
    return _out(post)


@router.patch("/{post_id}")
def update_post(post_id: int, payload: PostPatch, admin: str = Depends(get_current_admin), db: Session = Depends(get_db)):
    post = _get(db, post_id)
    if post.status == "published":
        raise HTTPException(409, "Published posts cannot be edited")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(post, key, value)
    post.content_version += 1
    # Any edit invalidates approval. This prevents publishing content that was not reviewed.
    post.status = "draft"
    post.approved_version = None
    _audit(db, admin, "post_edited", post.id)
    db.commit()
    db.refresh(post)
    return _out(post)


@router.post("/{post_id}/approve")
def approve_post(post_id: int, admin: str = Depends(get_current_admin), db: Session = Depends(get_db)):
    post = _get(db, post_id)
    if post.status == "published":
        raise HTTPException(409, "Post is already published")
    post.status = "approved"
    post.approved_version = post.content_version
    _audit(db, admin, "post_approved", post.id)
    db.commit()
    db.refresh(post)
    return _out(post)


@router.post("/{post_id}/reject")
def reject_post(post_id: int, admin: str = Depends(get_current_admin), db: Session = Depends(get_db)):
    post = _get(db, post_id)
    if post.status == "published":
        raise HTTPException(409, "Published posts cannot be rejected")
    post.status = "rejected"
    post.approved_version = None
    _audit(db, admin, "post_rejected", post.id)
    db.commit()
    db.refresh(post)
    return _out(post)


@router.post("/{post_id}/publish")
def publish(post_id: int, payload: PublishRequest, admin: str = Depends(get_current_admin), db: Session = Depends(get_db)):
    post = _get(db, post_id)
    if not payload.confirm:
        raise HTTPException(400, "Explicit publication confirmation is required")
    if post.status != "approved" or post.approved_version != post.content_version:
        raise HTTPException(409, "Approve the current version before publishing")
    try:
        message_id = publish_post(title=post.title, body=post.body, image_url=post.image_url)
    except TelegramPublishError as exc:
        raise HTTPException(502, str(exc)) from exc
    post.status = "published"
    post.telegram_message_id = message_id
    post.published_at = datetime.now(timezone.utc)
    _audit(db, admin, "post_published", post.id)
    db.commit()
    db.refresh(post)
    return _out(post)
