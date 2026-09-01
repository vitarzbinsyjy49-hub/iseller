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
    decode_token_payload,
    verify_telegram_init_data,
)
from app.services.token_revocation import is_refresh_token_revoked, revoke_refresh_token
from app.services import ad_touch
from app.services.telegram_bot import parse_ad_payload
from app.db.audit import audit
from app.db.session import get_db
from app.models.analytics_event import AnalyticsEvent
from app.models.user import User
from app.schemas.auth import AdminLoginIn, RefreshIn, TelegramAuthIn, TokenPair
from app.api.deps import client_ip

router = APIRouter(prefix="/auth", tags=["auth"])


def _get_or_create_user(
    db: Session, tg_user: dict, request: Request, start_param: str | None = None,
) -> User:
    user = db.execute(select(User).where(User.telegram_id == tg_user["id"])).scalar_one_or_none()
    created = user is None
    if created:
        user = User(telegram_id=tg_user["id"])
        db.add(user)
    user.username = tg_user.get("username")
    user.first_name = tg_user.get("first_name")
    user.last_name = tg_user.get("last_name")
    user.photo_url = tg_user.get("photo_url")
    # Источник первого прихода — ТОЛЬКО при создании и ТОЛЬКО из ?startapp=
    # рекламной ссылки (ad_<канал>). Существующему пользователю не трогаем:
    # органический повторный визит по ad-ссылке не должен переписывать его
    # настоящий источник. product_/share-ссылки в start_param сюда не попадают
    # намеренно — это не рекламный канал, а шеринг между людьми.
    ad_slug = parse_ad_payload(start_param) if (created and start_param) else None
    if created and ad_slug is None:
        # Метка не пришла в start_param — смотрим первое касание в чате с ботом
        # (t.me/<bot>?start=ad_*): Telegram НЕ прокидывает start_param в Mini
        # App, открытый web_app-кнопкой из чата, поэтому по такой ссылке
        # источник может дойти до нас только так. Приоритет остаётся за
        # start_param: он точнее и приходит в том же запросе.
        # Условие `created` общее с веткой выше не случайно: первое касание —
        # это первое касание, и у существующего пользователя оно ничего не
        # переписывает, как и рекламный start_param.
        ad_slug = ad_touch.slug_for(db, tg_user["id"])
    if ad_slug is not None:
        user.acquisition_source = f"ad_{ad_slug}"
    db.commit()
    db.refresh(user)
    audit(db, f"tg:{user.telegram_id}", "register" if created else "login", ip=client_ip(request))
    if ad_slug is not None:
        # Сырое событие — тот же слой, что и продуктовая аналитика (см.
        # app/api/events.py), но пишет бэкенд сам: это первый вход пользователя,
        # клиенту ещё нечем было бы его отправить.
        db.add(AnalyticsEvent(user_id=user.id, event="ad_signup", payload={"source": ad_slug}))
        db.commit()
    return user


def _token_pair(subject: str) -> TokenPair:
    return TokenPair(access_token=create_access_token(subject), refresh_token=create_refresh_token(subject))


@router.post("/telegram", response_model=TokenPair)
def auth_telegram(body: TelegramAuthIn, request: Request, db: Session = Depends(get_db)):
    try:
        tg_user = verify_telegram_init_data(body.init_data)
    except TelegramAuthError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Telegram auth failed: {e}")
    user = _get_or_create_user(db, tg_user, request, start_param=body.start_param)
    return _token_pair(f"user:{user.id}")


@router.post("/dev", response_model=TokenPair)
def auth_dev(request: Request, db: Session = Depends(get_db)):
    """Вход тестовым пользователем из браузера. Работает только при DEV_MODE=true."""
    if not settings.DEV_MODE:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    tg_user = {"id": 1, "username": "dev_user", "first_name": "Dev", "last_name": "User"}
    user = _get_or_create_user(db, tg_user, request)
    return _token_pair(f"user:{user.id}")


@router.post("/admin/dev", response_model=TokenPair)
def admin_auth_dev(request: Request, db: Session = Depends(get_db)):
    """Админ-токен для локальной приёмки БЕЗ пароля. Только при DEV_MODE=true.

    Зачем: приёмочные прогоны и скриншоты админки не должны требовать ввода
    настоящего пароля — ни руками, ни в скрипте. Пароль, попавший в историю
    команд или в лог CI, перестаёт быть паролем.

    Почему это безопасно:
    - решение принимает СЕРВЕР, а не флаг сборки: при DEV_MODE=false маршрута
      не существует (404), сколько бы клиент ни просил;
    - `settings.ADMIN_PASSWORD` здесь не читается вовсе — сравнивать нечего;
    - subject отдельный (`admin:dev@local`), поэтому в audit_logs видно, что
      действие сделано тестовым входом, а не настоящим администратором.

    Симметрично уже существующему `/auth/dev` для покупателя.
    """
    if not settings.DEV_MODE:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    subject = "admin:dev@local"
    audit(db, subject, "admin_login_dev", ip=client_ip(request))
    return _token_pair(subject)


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
def refresh(body: RefreshIn, request: Request, db: Session = Depends(get_db)):
    """Обмен refresh-токена на новую пару.

    v5.4.2: refresh одноразовый. Предъявленный токен отзывается (его jti пишется
    в revoked_refresh_tokens), повторное использование -> 401. Это ограничивает
    окно украденного токена одним запросом вместо REFRESH_TOKEN_DAYS.

    Совместимость: токены, выданные до этой версии, не содержат jti. Разлогинивать
    из-за этого живых пользователей не нужно — такой токен принимается один раз и
    меняется на новый (уже с jti). Легаси-окно закрывается само за
    REFRESH_TOKEN_DAYS.
    """
    try:
        payload = decode_token_payload(body.refresh_token, "refresh")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired refresh token")

    subject = str(payload["sub"])
    jti = payload.get("jti")
    if jti:
        if is_refresh_token_revoked(db, jti):
            # токен уже был обменян: либо повтор, либо кража -> не продлеваем
            audit(db, subject, "refresh_token_reuse_rejected", ip=client_ip(request))
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired refresh token")
        revoke_refresh_token(db, jti=jti, subject=subject, exp=payload.get("exp"))

    return _token_pair(subject)
