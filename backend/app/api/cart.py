"""Корзина Mini App (серверное хранение) и общая заявка по ней.

GET    /api/cart                 — состояние корзины (актуальные цены и наличие)
POST   /api/cart/items           — добавить товар (повтор увеличивает количество)
PATCH  /api/cart/items/{item_id} — изменить количество (0 = удалить)
DELETE /api/cart/items/{item_id} — удалить позицию
DELETE /api/cart                 — очистить корзину
POST   /api/cart/checkout        — отправить ОДНУ общую заявку по корзине

Всё под ``get_current_user``: корзина принадлежит пользователю, чужую не
прочитать и не изменить. Роутер намеренно тонкий — правила в ``services/cart.py``.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.analytics_event import AnalyticsEvent
from app.models.user import User
from app.schemas.cart import CartItemIn, CartQuantityIn, CheckoutIn
from app.services import cart as cart_service
from app.services.cart import CartError

logger = logging.getLogger("techshop.cart")
router = APIRouter(prefix="/cart", tags=["cart"])

# Код ошибки бизнес-правила -> HTTP-статус. 409 у «товар стал недоступен»
# осознанно: это не ошибка запроса (400) и не отсутствие ресурса (404), а
# конфликт состояния, который клиент обязан показать и дать исправить.
_STATUS_BY_CODE = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "not_orderable": status.HTTP_409_CONFLICT,
    "items_unavailable": status.HTTP_409_CONFLICT,
    "cart_full": status.HTTP_409_CONFLICT,
    "cart_conflict": status.HTTP_409_CONFLICT,
    "empty_cart": status.HTTP_400_BAD_REQUEST,
    "consent_required": status.HTTP_400_BAD_REQUEST,
    "phone_required": status.HTTP_400_BAD_REQUEST,
}


def _http(e: CartError) -> HTTPException:
    """Ошибка правила -> HTTP. detail — текст для человека, без стектрейса;
    машинный код и подробности отдельными полями, чтобы клиент мог показать
    конкретные проблемные позиции."""
    return HTTPException(
        _STATUS_BY_CODE.get(e.code, status.HTTP_400_BAD_REQUEST),
        detail={"code": e.code, "detail": e.message, **e.details},
    )


@router.get("")
def get_cart(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return cart_service.cart_payload(db, user.id)


@router.post("/items", status_code=status.HTTP_200_OK)
def add_item(body: CartItemIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        item = cart_service.add_item(db, user.id, body.product_id, body.quantity)
    except CartError as e:
        raise _http(e)
    _track(db, user.id, "cart_add", {"product_id": body.product_id, "quantity": item.quantity})
    return cart_service.cart_payload(db, user.id)


@router.patch("/items/{item_id}")
def update_item(
    item_id: int,
    body: CartQuantityIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        item = cart_service.set_quantity(db, user.id, item_id, body.quantity)
    except CartError as e:
        raise _http(e)
    _track(
        db, user.id,
        "cart_remove" if item is None else "cart_quantity_change",
        {"quantity": body.quantity},
    )
    return cart_service.cart_payload(db, user.id)


@router.delete("/items/{item_id}")
def delete_item(item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        cart_service.remove_item(db, user.id, item_id)
    except CartError as e:
        raise _http(e)
    _track(db, user.id, "cart_remove", {})
    return cart_service.cart_payload(db, user.id)


@router.delete("")
def clear(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cart_service.clear_cart(db, user.id)
    _track(db, user.id, "cart_remove", {"cleared": True})
    return cart_service.cart_payload(db, user.id)


@router.post("/checkout", status_code=status.HTTP_201_CREATED)
def checkout(body: CheckoutIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not body.consent:
        raise _http(CartError("consent_required", "Нужно согласие на обработку данных и связь"))
    # Телефон обязателен, только если менеджеру некуда ответить в Telegram —
    # то же правило, что и у сценарных заявок (Home.requirePhone).
    if not user.username and not (body.phone or "").strip():
        raise _http(CartError("phone_required", "Укажите телефон — менеджеру нужно с вами связаться"))

    try:
        lead, created = cart_service.checkout(
            db, user,
            name=body.name,
            phone=body.phone,
            fulfillment_type=body.fulfillment_type,
            comment=body.comment,
            idempotency_key=body.idempotency_key,
        )
    except CartError as e:
        raise _http(e)

    if created:
        # Аналитика и сигналы рекомендаций — после успешной транзакции и никогда
        # не роняют ответ: заявка уже создана, терять её из-за аналитики нельзя.
        # Payload — только безопасные метаданные (без телефона/имени/комментария).
        _track(db, user.id, "checkout_success", {
            "lead_id": lead.id,
            "items_count": lead.items_count,
            "positions": len(lead.items or []),
        })
        _track(db, user.id, "lead_created", {
            "lead_id": lead.id, "source": lead.source, "lead_type": lead.lead_type,
            "product_id": None,
        })
        try:
            from app.services.recommendations import record_event
            for item in (lead.items or [])[:20]:
                if item.product_id:
                    record_event(db, user.id, "lead_created", product_id=item.product_id,
                                 source="cart")
        except Exception:  # noqa: BLE001 — рекомендации не критичны для заявки
            db.rollback()
            logger.exception("rec cart lead events failed")

    return {"lead": lead.to_dict(), "created": created, "cart": cart_service.cart_payload(db, user.id)}


def _track(db: Session, user_id: int, event: str, payload: dict) -> None:
    """Событие воронки. Никогда не роняет основной запрос."""
    try:
        db.add(AnalyticsEvent(user_id=user_id, event=event, payload=payload))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("analytics %s failed", event)
