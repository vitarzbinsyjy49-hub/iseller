"""Общие зависимости API: текущий пользователь, текущий админ."""
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.security import decode_token
from app.db.session import get_db
from app.models.user import User

bearer = HTTPBearer(auto_error=False)


def _credentials(creds: HTTPAuthorizationCredentials | None) -> str:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return creds.credentials


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    token = _credentials(creds)
    try:
        subject = decode_token(token, "access")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    if not subject.startswith("user:"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token subject")
    user = db.get(User, int(subject.removeprefix("user:")))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return user


def get_current_admin(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
    token = _credentials(creds)
    try:
        subject = decode_token(token, "access")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    if not subject.startswith("admin:"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    return subject.removeprefix("admin:")


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"
