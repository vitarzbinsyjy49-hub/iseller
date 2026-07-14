"""Безопасность: проверка Telegram initData, JWT-токены, пароли."""
import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl

import jwt
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

MAX_INITDATA_AGE_SECONDS = 3600  # initData старше часа не принимаем


class TelegramAuthError(Exception):
    pass


def verify_telegram_init_data(init_data: str) -> dict:
    """Проверяет подпись initData от Telegram Mini App.

    Алгоритм из официальной документации Telegram:
    secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
    hash = HMAC_SHA256(key=secret_key, msg=data_check_string)
    """
    if not settings.TELEGRAM_BOT_TOKEN:
        raise TelegramAuthError("Bot token is not configured")

    parsed = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        raise TelegramAuthError("hash is missing")

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
    secret_key = hmac.new(b"WebAppData", settings.TELEGRAM_BOT_TOKEN.encode(), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        raise TelegramAuthError("invalid hash")

    auth_date = int(parsed.get("auth_date", "0"))
    if time.time() - auth_date > MAX_INITDATA_AGE_SECONDS:
        raise TelegramAuthError("initData is expired")

    user_raw = parsed.get("user")
    if not user_raw:
        raise TelegramAuthError("user is missing")
    return json.loads(user_raw)


def _create_token(subject: str, token_type: str, expires_delta: timedelta) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": subject, "type": token_type, "iat": now, "exp": now + expires_delta}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm="HS256")


def create_access_token(subject: str) -> str:
    return _create_token(subject, "access", timedelta(minutes=settings.ACCESS_TOKEN_MINUTES))


def create_refresh_token(subject: str) -> str:
    return _create_token(subject, "refresh", timedelta(days=settings.REFRESH_TOKEN_DAYS))


def decode_token(token: str, expected_type: str) -> str:
    """Возвращает subject токена или бросает jwt-исключение."""
    payload = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
    if payload.get("type") != expected_type:
        raise jwt.InvalidTokenError("wrong token type")
    return str(payload["sub"])


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)
