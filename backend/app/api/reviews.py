"""Отзывы: чтение витриной и отправка покупателем.

GET  /api/reviews                     — одобренные отзывы (общая лента)
GET  /api/reviews/product/{id}        — одобренные отзывы товара + сводка
GET  /api/reviews/lead/{id}           — свой отзыв по своей заявке (форма)
POST /api/reviews/lead/{id}           — оставить/поправить отзыв

Чтение открыто (это витрина), отправка — только автору заявки. Проверка
владения обязательна и не сводится к «пришёл валидный токен»: без неё любой
авторизованный мог бы оставить отзыв по чужой покупке, и «подтверждено»
перестало бы что-либо значить.

Модерация живёт в admin_crm — там же, где менеджер и так работает с заявками.
"""
import logging

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import client_ip, get_current_user
from app.core.config import settings
from app.core.rate_limit import check_rate_limit
from app.core.uploads import MAX_BYTES, is_allowed, save_image
from app.db.session import get_db
from app.models.lead import Lead
from app.models.review import Review
from app.models.user import User
from app.services import reviews as service

logger = logging.getLogger("techshop.reviews")
router = APIRouter(prefix="/reviews", tags=["reviews"])


def _own_lead(db: Session, lead_id: int, user: User) -> Lead:
    """Заявка пользователя, иначе 404.

    Именно 404, а не 403: чужая заявка для этого пользователя не существует, и
    отвечать «есть, но не твоя» значит подтверждать её существование.

    Заявка БЕЗ владельца (`user_id IS NULL`) тоже чужая. Прежнее условие
    пропускало её любому авторизованному, и это была не теория: модель
    допускает такие заявки (`Lead.user_id` nullable), а появятся они в первый
    же раз, когда менеджер заведёт заказ с телефонного звонка или его принесёт
    импорт. Тогда любой человек с Telegram-аккаунтом смог бы и прочитать состав
    чужой покупки, и повесить на неё отзыв с бейджем «покупка подтверждена» —
    то есть ровно то, ради чего этот бейдж и существует, перестало бы
    что-нибудь значить.
    """
    lead = db.get(Lead, lead_id)
    if lead is None or lead.user_id is None or lead.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заявка не найдена")
    return lead


@router.get("")
def list_reviews(db: Session = Depends(get_db),
                 limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    return {"items": [r.to_public() for r in service.approved(db, limit=limit, offset=offset)]}


@router.get("/product/{product_id}")
def product_reviews(product_id: int, db: Session = Depends(get_db),
                    limit: int = Query(20, ge=1, le=100)):
    return {
        **service.summary_for_product(db, product_id),
        "items": [r.to_public() for r in service.approved_for_product(db, product_id, limit=limit)],
    }


@router.get("/lead/{lead_id}")
def my_review(lead_id: int, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    """Что показать в форме: можно ли оставить отзыв и что уже написано."""
    lead = _own_lead(db, lead_id, user)
    row = db.scalar(select(Review).where(Review.lead_id == lead.id))
    return {
        "can_review": service.can_review(lead),
        "lead": {
            "id": lead.id,
            "public_number": lead.public_number,
            "product_id": lead.product_id,
            "product_title": lead.product_title,
            "items_count": lead.items_count or 0,
        },
        "review": row.to_admin() if row else None,
    }


@router.post("/lead/{lead_id}", status_code=status.HTTP_201_CREATED)
def submit_review(
    lead_id: int,
    rating: int = Body(..., embed=True),
    text: str | None = Body(None, embed=True),
    photos: list[str] | None = Body(None, embed=True),
    product_id: int | None = Body(None, embed=True),
    author_name: str | None = Body(None, embed=True),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lead = _own_lead(db, lead_id, user)
    try:
        row = service.submit(
            db, lead=lead, rating=rating, text=text, photos=photos,
            product_id=product_id, author_name=author_name,
        )
    except service.ReviewError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    db.commit()
    db.refresh(row)
    logger.info("отзыв по заявке %s принят на модерацию", lead.id)
    return row.to_admin()


#: Сколько фото принимаем в одном отзыве. Столько же, сколько у товара —
#: больше не помещается ни в блок карточки, ни во внимание читателя.
MAX_REVIEW_PHOTOS = 10


@router.post("/photo", status_code=status.HTTP_201_CREATED)
async def upload_review_photo(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """Фото к отзыву. Кладём туда же, куда фото товаров.

    Эндпоинт отдельный от админского: тот под get_current_admin, а сюда
    загружает покупатель. Проверки те же, что у админского, и они здесь не
    формальность — файл приходит с чужого устройства.

    Суточная квота — такая же и по той же причине, что у фото заявки
    «Предложить товар» (api/leads.py). Проверки типа и размера защищают от
    мусора в ОДНОМ запросе, но ничего не говорят про их количество: без
    потолка ручка остаётся самым дешёвым способом забить диск на сервере.
    """
    rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
    if not check_rate_limit(
        f"review_photo:{rl_key}",
        limit=settings.REVIEW_PHOTO_DAILY_LIMIT_PER_USER,
        window_seconds=86400,
    ):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много фото за сегодня")
    if not is_allowed(file.content_type):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Только изображения: jpg, png, webp, gif")
    # Отказ по заголовку — ДО чтения тела: Starlette сбрасывает крупную загрузку
    # во временный файл на диске, то есть без этой проверки гигабайт успевает
    # лечь на диск и только потом получить 400. Заголовку не доверяем как
    # единственной проверке (его может не быть, и он может врать) — это ранний
    # отсев, проверка по факту прочитанного ниже остаётся на месте.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    return {"url": save_image(file.content_type, data)}
