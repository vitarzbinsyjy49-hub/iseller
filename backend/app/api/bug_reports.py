"""«Сообщить об ошибке» из профиля Mini App.

POST /api/bug-reports         — отправить сообщение (текст, скриншоты, контекст)
POST /api/bug-reports/photo   — загрузить скриншот

Разбор — во вкладке «Ошибки» админки (admin_crm). Почему это не заявка — см.
models/bug_report.py.
"""
import logging

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import client_ip, get_current_user
from app.core.config import settings
from app.core.rate_limit import check_rate_limit
from app.core.uploads import MAX_BYTES, is_allowed, save_image
from app.db.session import get_db
from app.models.user import User
from app.services import bug_reports as service

logger = logging.getLogger("techshop.bug_reports")
router = APIRouter(prefix="/bug-reports", tags=["bug-reports"])


def _rl_key(request: Request, user: User) -> str:
    return f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"


@router.post("", status_code=status.HTTP_201_CREATED)
def submit_bug_report(
    request: Request,
    text: str | None = Body(None, embed=True),
    photos: list[str] | None = Body(None, embed=True),
    context: dict | None = Body(None, embed=True),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Каждое сообщение — алерт владельцу в Telegram: без потолка один аккаунт
    # превращает эту кнопку в спам в личку.
    if not check_rate_limit(
        f"bug_report:{_rl_key(request, user)}",
        limit=settings.BUG_REPORT_DAILY_LIMIT_PER_USER,
        window_seconds=86400,
    ):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много сообщений за сегодня")
    try:
        row = service.submit(db, user=user, text=text, photos=photos, context=context)
    except service.BugReportError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    db.commit()
    db.refresh(row)
    logger.info("сообщение об ошибке #%s принято", row.id)
    return {"id": row.id, "status": row.status}


@router.post("/photo", status_code=status.HTTP_201_CREATED)
async def upload_bug_screenshot(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """Скриншот к сообщению. Проверки — как у фото отзыва (api/reviews.py):
    ручка открыта любому авторизованному, и без суточного потолка это самый
    дешёвый способ забить диск на сервере."""
    if not check_rate_limit(
        f"bug_photo:{_rl_key(request, user)}",
        limit=settings.BUG_REPORT_PHOTO_DAILY_LIMIT_PER_USER,
        window_seconds=86400,
    ):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много скриншотов за сегодня")
    if not is_allowed(file.content_type):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Только изображения: jpg, png, webp, gif")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    return {"url": save_image(file.content_type, data)}
