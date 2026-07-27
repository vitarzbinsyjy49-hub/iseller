"""Отзыв refresh-токенов (v5.4.2).

Хранит jti уже использованных refresh-токенов, чтобы их нельзя было предъявить
второй раз. Таблица маленькая и самоочищающаяся: запись нужна ровно до exp
исходного токена, дальше JWT протухает сам.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.revoked_token import RevokedRefreshToken


def is_refresh_token_revoked(db: Session, jti: str) -> bool:
    return db.execute(
        select(RevokedRefreshToken.id).where(RevokedRefreshToken.jti == jti).limit(1)
    ).scalar() is not None


def _exp_to_datetime(exp) -> datetime:
    """exp из JWT (unix seconds) -> aware datetime. Нет/кривой -> максимальный
    срок жизни refresh-токена (запись не удалим раньше времени)."""
    try:
        return datetime.fromtimestamp(int(exp), tz=timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_DAYS)


def revoke_refresh_token(db: Session, *, jti: str, subject: str, exp=None) -> None:
    """Пометить jti использованным. Гонка двух одновременных обменов не должна
    ронять запрос: уникальный индекс отсекает дубль, IntegrityError гасим."""
    db.add(RevokedRefreshToken(jti=jti, subject=subject, expires_at=_exp_to_datetime(exp)))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()          # уже отозван параллельным запросом — это ок
    purge_expired(db)


def purge_expired(db: Session) -> int:
    """Удалить записи, чей токен и так уже протух. Дёшево и не требует крона."""
    result = db.execute(
        delete(RevokedRefreshToken).where(RevokedRefreshToken.expires_at < datetime.now(timezone.utc))
    )
    db.commit()
    return result.rowcount or 0
