import secrets

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.rate_limit import check_rate_limit
from app.core.security import (
    TelegramAuthError,
    create_access_token,
    create_refresh_token,
    decode_token,
    verify_telegram_init_data,
)
from app.db.audit import audit
from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import AdminLoginIn, RefreshIn, TelegramAuthIn, TokenPair
from app.api.deps import client_ip

router = APIRouter(prefix="/auth", tags=["auth"])


def _get_or_create_user(db: Session, tg_user: dict, request: Request) -> User:
    user = db.execute(select(User).where(User.telegram_id == tg_user["id"])).scalar_one_or_none()
    created = user is None
    if created:
        user = User(telegram_id=tg_user["id"])
        db.add(user)
    user.username = tg_user.get("username")
    user.first_name = tg_user.get("first_name")
    user.last_name = tg_user.get("last_name")
    db.commit()
    db.refresh(user)
    audit(db, f"tg:{user.telegram_id}", "register" if created else "login", ip=client_ip(request))
    return user


def _token_pair(subject: str) -> TokenPair:
    return TokenPair(access_token=create_access_token(subject), refresh_token=create_refresh_token(subject))


@router.post("/telegram", response_model=TokenPair)
def auth_telegram(body: TelegramAuthIn, request: Request, db: Session = Depends(get_db)):
    try:
        tg_user = verify_telegram_init_data(body.init_data)
    except TelegramAuthError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Telegram auth failed: {e}")
    user = _get_or_create_user(db, tg_user, request)
    return _token_pair(f"user:{user.id}")


@router.post("/dev", response_model=TokenPair)
def auth_dev(request: Request, db: Session = Depends(get_db)):
    """Вход тестовым пользователем из браузера. Работает только при DEV_MODE=true."""
    if not settings.DEV_MODE:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    tg_user = {"id": 1, "username": "dev_user", "first_name": "Dev", "last_name": "User"}
    user = _get_or_create_user(db, tg_user, request)
    return _token_pair(f"user:{user.id}")


@router.post("/admin/login", response_model=TokenPair)
def admin_login(body: AdminLoginIn, request: Request, db: Session = Depends(get_db)):
    """Вход администратора.

    v5.4.2: (1) rate limit по IP — пароль нельзя перебирать бесконечно; лимит
    считается ДО проверки пароля, поэтому верный пароль не обходит блокировку;
    (2) сравнение email/пароля через compare_digest — без утечки по времени.
    """
    ip = client_ip(request)
    if not check_rate_limit(f"admin_login:{ip}", settings.ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE):
        audit(db, f"admin:{body.email}", "admin_login_rate_limited", ip=ip)
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Слишком много попыток входа. Попробуйте через минуту.",
        )
    email_ok = secrets.compare_digest(body.email or "", settings.ADMIN_EMAIL)
    password_ok = secrets.compare_digest(body.password or "", settings.ADMIN_PASSWORD)
    ok = email_ok and password_ok
    audit(db, f"admin:{body.email}", "admin_login" if ok else "admin_login_failed", ip=ip)
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    return _token_pair(f"admin:{body.email}")


@router.post("/refresh", response_model=TokenPair)
def refresh(body: RefreshIn):
    try:
        subject = decode_token(body.refresh_token, "refresh")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired refresh token")
    return _token_pair(subject)
