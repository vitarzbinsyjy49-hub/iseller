"""Заявки (Lead / OrderRequest) — пользовательская часть.

POST /api/leads        — создать заявку (JWT). Пишет событие lead_created.
GET  /api/leads/my     — мои заявки (JWT), для экрана «Заявки» в Mini App.
"""
import hashlib
import logging

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import client_ip, get_current_user
from app.core.config import settings
from app.core.rate_limit import check_rate_limit
from app.core.uploads import MAX_BYTES, MAX_PRODUCT_IMAGES, URL_PREFIX, is_allowed, save_image
from app.db.session import get_db
from app.models.analytics_event import AnalyticsEvent
from app.models.audit import AuditLog
from app.models.lead import DEFAULT_LEAD_TYPE, DELIVERY_METHODS, LEAD_SOURCES, Lead
from app.models.product import Product
from app.models.user import User
from app.schemas.ai import LeadIn
from app.services.offer_links import OfferLinkError, normalize_offer_url, shop_name

logger = logging.getLogger("techshop.leads")
router = APIRouter(prefix="/leads", tags=["leads"])

PRICE_OFFER_TYPE = "price_offer"
#: Потолок цены конкурента. Не «правильная» цена, а граница правдоподобия:
#: всё выше — опечатка или мусор, и в заявке ему делать нечего.
MAX_COMPETITOR_PRICE = 100_000_000


def _competitor_price(raw) -> float | None:
    """Цена у конкурента со слов покупателя. Пусто — допустимо, мусор — нет.

    Поле необязательное: заставлять человека вводить цифру ради галочки значит
    потерять часть заявок. Но если цифра пришла, она обязана быть числом —
    строка «дешевле» в этом поле дороже, чем её отсутствие: менеджер увидит
    заполненное поле и не станет открывать ссылку.
    """
    if raw is None or raw == "":
        return None
    if isinstance(raw, bool):
        raise HTTPException(422, "Цена должна быть числом")
    try:
        value = float(str(raw).replace(",", ".").replace(" ", ""))
    except (TypeError, ValueError):
        raise HTTPException(422, "Цена должна быть числом") from None
    if value <= 0 or value > MAX_COMPETITOR_PRICE:
        raise HTTPException(422, "Такой цены не бывает — проверьте цифру")
    return value


def _prepare_price_offer(meta: dict) -> tuple[dict, str]:
    """Разобрать metadata заявки «нашли дешевле». Возвращает (metadata, ключ).

    Ссылку проверяем на входе, а не при показе: заявка живёт в базе долго, и
    кривой адрес всплыл бы у менеджера в самый неудобный момент.
    """
    try:
        url = normalize_offer_url(str(meta.get("competitor_url") or ""))
    except OfferLinkError as exc:
        raise HTTPException(422, str(exc)) from exc

    meta["competitor_url"] = url
    meta["competitor_shop"] = shop_name(url)
    price = _competitor_price(meta.get("competitor_price"))
    if price is None:
        meta.pop("competitor_price", None)
    else:
        meta["competitor_price"] = price

    # Ключ идемпотентности собираем из ТОВАРА и НОРМАЛИЗОВАННОЙ ссылки: двойной
    # тап и ретрай после таймаута обязаны вернуть ту же заявку, иначе владелец
    # получит два одинаковых сообщения в Telegram. Хэш — потому что колонка 64
    # символа, а ссылка бывает длиннее.
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:24]
    return meta, digest


def _notify_owner(db: Session, lead: Lead, meta: dict) -> None:
    """Поставить владельцу уведомление о заявке «нашли дешевле».

    Сети здесь нет и быть не должно: покупатель нажал «Отправить», и его запрос
    не имеет права ждать Telegram — тем более падать вместе с ним. Строка уходит
    в ту же транзакцию, что и заявка.
    """
    from app.services.notification_templates import price_offer_message
    from app.services.notifications import admin_chat_id, enqueue

    chat_id = admin_chat_id()
    if chat_id is None:
        return

    enqueue(
        db,
        chat_id=chat_id,
        kind="price_offer",
        message=price_offer_message(
            product_title=lead.product_title or "товар",
            our_price=float(lead.product_price) if lead.product_price is not None else None,
            competitor_price=meta.get("competitor_price"),
            competitor_url=meta["competitor_url"],
            competitor_shop=meta["competitor_shop"],
            username=lead.username,
        ),
        dedupe_key=f"price_offer:{lead.id}",
    )


def _safe_price(raw) -> float | None:
    """`price_wanted` со слов покупателя — только для текста уведомления, не
    для заявки. В отличие от `_competitor_price` (price_offer), здесь мусор
    НЕ должен ронять запрос: заявка обязана создаться в любом случае, а
    нечисловая цена в уведомлении — просто «—» (см. format_money(None))."""
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _own_photos(raw) -> list[str]:
    """Оставить в `metadata.photos` только файлы, загруженные к нам.

    metadata приходит от клиента, а эти ссылки потом (1) показываются модератору
    как <a href> в админке, где в localStorage лежат его токены, и (2) уезжают
    в `images` товара при публикации на витрину. `javascript:`, `data:` и чужой
    хост в таком месте — это XSS на origin админки и подмена картинки в
    каталоге, поэтому разрез строгий: наш собственный префикс загрузок и ничего
    больше.

    Мусор молча выбрасываем, а не отклоняем заявку целиком: тот же принцип, что
    у `_safe_price` — заявка обязана создаться (см. `_competitor_price`, где
    модель осознанно другая).
    """
    if not isinstance(raw, list):
        return []
    prefix = URL_PREFIX + "/"
    clean = [u for u in raw if isinstance(u, str) and u.startswith(prefix)]
    return clean[:MAX_PRODUCT_IMAGES]


def _notify_sell_item(db: Session, lead: Lead, meta: dict) -> None:
    """Алерт модератору о новой заявке «Предложить товар» — та же схема, что
    _notify_owner для price_offer: без сети, той же транзакцией."""
    from app.services.notification_templates import sell_item_message
    from app.services.notifications import admin_chat_id, enqueue

    chat_id = admin_chat_id()
    if chat_id is None:
        return

    enqueue(
        db, chat_id=chat_id, kind="sell_item",
        message=sell_item_message(
            title=str(meta.get("title") or "товар"),
            price_wanted=_safe_price(meta.get("price_wanted")),
            phone=lead.phone, username=lead.username,
        ),
        dedupe_key=f"sell_item:{lead.id}",
    )


def _notify_new_lead(db: Session, lead: Lead) -> None:
    """Алерт менеджеру о новой заявке — для типов без своего специфичного
    уведомления (price_offer/sell_item оповещают выше, до этой ветки)."""
    from app.services.notification_templates import new_lead_message
    from app.services.notifications import admin_chat_id, enqueue

    chat_id = admin_chat_id()
    if chat_id is None:
        return

    enqueue(
        db, chat_id=chat_id, kind="new_lead",
        message=new_lead_message(
            public_number=lead.public_number,
            items_count=lead.items_count or 0,
            estimated_total=float(lead.estimated_total) if lead.estimated_total is not None else None,
            currency=lead.currency or "RUB",
            product_title=lead.product_title,
            lead_type=lead.lead_type,
            username=lead.username,
            phone=lead.phone,
            message=lead.message,
        ),
        dedupe_key=f"lead:{lead.id}:created",
    )


def _notify_cancelled_by_user(db: Session, lead: Lead) -> None:
    """Алерт менеджеру: покупатель сам отменил заявку — симметрично тому, как
    менеджер, меняя статус, уведомляет покупателя (_notify_status_change в
    admin_crm.py). Владельца о его же действии повторно НЕ уведомляем: он
    только что увидел результат на экране, а _STATUS_TEXTS["cancelled"] в
    lead_status_message продолжает срабатывать только при отмене АДМИНОМ."""
    from app.services.notification_templates import lead_cancelled_by_user_message
    from app.services.notifications import admin_chat_id, enqueue

    chat_id = admin_chat_id()
    if chat_id is None:
        return

    enqueue(
        db, chat_id=chat_id, kind="lead_cancelled",
        message=lead_cancelled_by_user_message(
            public_number=lead.public_number,
            items_count=lead.items_count or 0,
            estimated_total=float(lead.estimated_total) if lead.estimated_total is not None else None,
            currency=lead.currency or "RUB",
            product_title=lead.product_title,
            username=lead.username,
        ),
        dedupe_key=f"lead:{lead.id}:cancelled_by_user",
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_lead(
    body: LeadIn, request: Request,
    user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    lead_type = body.lead_type or DEFAULT_LEAD_TYPE
    if lead_type == "sell_item":
        rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
        if not check_rate_limit(
            f"sell_item:{rl_key}",
            limit=settings.SELL_ITEM_DAILY_LIMIT_PER_USER,
            window_seconds=86400,
        ):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много заявок за сегодня")
    # Название и цену товара берём из БД (не доверяем клиенту), если передан product_id.
    product_title = body.product_title
    product_price = None
    product_category = None
    if body.product_id:
        product = db.get(Product, body.product_id)
        if product:
            product_title = product.title
            product_price = product.price
            product_category = product.category

    meta = dict(body.metadata or {})
    if lead_type == "sell_item" and "photos" in meta:
        meta["photos"] = _own_photos(meta.get("photos"))
    idempotency_key = None
    if lead_type == PRICE_OFFER_TYPE:
        meta, digest = _prepare_price_offer(meta)
        idempotency_key = f"po:{body.product_id or 0}:{digest}"
        existing = db.execute(
            select(Lead).where(Lead.user_id == user.id,
                               Lead.idempotency_key == idempotency_key)
        ).scalars().first()
        if existing is not None:
            # Повтор той же ссылки — это тот же запрос, а не второй. Возвращаем
            # исходную заявку: человек увидит подтверждение, владелец не получит
            # дубль в Telegram.
            return existing.to_dict()

    lead = Lead(
        user_id=user.id,
        telegram_id=user.telegram_id,
        name=body.name or user.first_name,
        phone=body.phone,
        username=user.username,
        product_id=body.product_id,
        product_title=product_title,
        product_price=product_price,
        message=body.message,
        source=body.source if body.source in LEAD_SOURCES else "other",
        # lead_type/metadata уже нормализованы/очищены в схеме LeadIn.
        lead_type=lead_type,
        meta=meta,
        idempotency_key=idempotency_key,
        delivery_method=body.delivery_method if body.delivery_method in DELIVERY_METHODS else None,
        status="new",
    )
    db.add(lead)
    if lead_type == PRICE_OFFER_TYPE:
        # flush, а не commit: id нужен для ключа дедупликации, но уведомление
        # обязано уехать ТОЙ ЖЕ транзакцией, что и заявка. Иначе владелец
        # получит ссылку на заявку, которой в базе не окажется. Та же причина
        # flush (не commit) верна и для двух веток ниже — id лида нужен всем
        # dedupe_key.
        db.flush()
        _notify_owner(db, lead, meta)
    elif lead_type == "sell_item":
        db.flush()
        _notify_sell_item(db, lead, meta)
    else:
        db.flush()
        _notify_new_lead(db, lead)
    db.commit()
    db.refresh(lead)

    # Событие воронки (не роняем запрос при ошибке аналитики).
    # Payload — только безопасные метаданные: без телефона/имени/комментария/metadata.
    try:
        db.add(AnalyticsEvent(user_id=user.id, event="lead_created",
                              payload={"lead_id": lead.id, "source": lead.source,
                                       "lead_type": lead.lead_type, "product_id": lead.product_id}))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("analytics lead_created failed")

    # Сильный сигнал для персональных рекомендаций (заявка = высокий вес)
    try:
        from app.services.recommendations import record_event
        record_event(db, user.id, "lead_created", product_id=body.product_id,
                     category=product_category, source="lead")
    except Exception:
        db.rollback()
        logger.exception("rec lead_created event failed")

    return lead.to_dict()


@router.get("/my")
def my_leads(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(Lead).where(Lead.user_id == user.id).order_by(Lead.id.desc())
    ).scalars().all()
    return {"leads": [l.to_dict() for l in rows]}


@router.post("/{lead_id}/cancel")
def cancel_lead(
    lead_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    """Пользователь отменяет СВОЮ заявку. Разрешено с любого статуса, кроме
    двух финальных (completed/cancelled) — менеджер мог уже взять заявку в
    работу, но пока сделка не закрыта, отмена всё равно доступна."""
    lead = db.get(Lead, lead_id)
    if lead is None or lead.user_id != user.id:
        # 404, а не 403: не подтверждаем существование чужой заявки различием кодов.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lead not found")
    if lead.status in ("completed", "cancelled"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Заявку в этом статусе отменить нельзя")

    previous = lead.status
    lead.status = "cancelled"
    db.add(AuditLog(
        actor=f"user:{user.id}",
        action="lead_status_changed",
        detail=f"lead={lead_id};from={previous};to=cancelled",
    ))
    _notify_cancelled_by_user(db, lead)
    db.commit()
    db.refresh(lead)
    return lead.to_dict()


@router.post("/uploads/marketplace-photo", status_code=status.HTTP_201_CREATED)
async def upload_marketplace_photo(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Фото для заявки «Предложить товар» — публичная (не admin) загрузка.

    Те же ограничения размера/типа, что у admin-загрузки (core/uploads.py), но
    свой дневной лимит на пользователя: без него загрузка фото — самый дешёвый
    способ забить диск, дешевле даже спам-заявок (см. Task 9)."""
    rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
    if not check_rate_limit(
        f"sell_item_upload:{rl_key}",
        limit=settings.SELL_ITEM_UPLOAD_DAILY_LIMIT_PER_USER,
        window_seconds=86400,
    ):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много фото за сегодня")
    if not is_allowed(file.content_type):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Только изображения: jpg, png, webp, gif")
    # Отказ по заголовку — ДО чтения тела: Starlette сбрасывает крупную загрузку
    # во временный файл на диске, то есть без этой проверки гигабайт успевает
    # лечь на диск и только потом получить 400. Ручка публичная, а лимит частоты
    # считает запросы, а не байты.
    #
    # Заголовку не доверяем как ЕДИНСТВЕННОЙ проверке: его может не быть
    # (chunked) или он может врать. Поэтому это ранний отсев, а проверка по
    # факту прочитанного ниже остаётся на месте.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    return {"url": save_image(file.content_type, data)}
