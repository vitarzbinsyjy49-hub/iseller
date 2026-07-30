"""Корзина: вся логика владения, количеств, цен и превращения в заявку.

API-слой (``app/api/cart.py``) остаётся тонким — здесь живут правила, которые
обязаны быть одинаковыми для всех входов и покрыты тестами:

* корзина всегда принадлежит текущему пользователю (чужую нельзя ни прочитать,
  ни изменить — фильтр по ``user_id`` в КАЖДОМ запросе, а не только в GET);
* количество зажимается режимом доступности товара (см. ``services.availability``);
* актуальная цена читается из каталога, ``added_price`` — только для сравнения;
* checkout — одна транзакция: заявка, позиции, перевод корзины в ``converted``;
* повторный checkout с тем же ключом идемпотентности возвращает ТУ ЖЕ заявку.

Склад корзина не трогает: ``products.stock`` — это склад, а не резерв.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.cart import MAX_CART_ITEMS, Cart, CartItem
from app.models.lead import CART_LEAD_SOURCE, CART_LEAD_TYPE, DELIVERY_METHODS, Lead
from app.models.lead_item import LeadItem
from app.models.product import Product
from app.services.availability import (
    availability_payload,
    clamp_quantity,
    is_orderable,
    resolve_availability,
)

logger = logging.getLogger("techshop.cart")


class CartError(Exception):
    """Ошибка бизнес-правила корзины. ``code`` переводится API в HTTP-статус."""

    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


# ---------------------------------------------------------------- корзина ----
def get_active_cart(db: Session, user_id: int) -> Cart | None:
    return db.execute(
        select(Cart).where(Cart.user_id == user_id, Cart.status == "active")
    ).scalars().first()


def get_or_create_active_cart(db: Session, user_id: int) -> Cart:
    """Активная корзина пользователя, при необходимости — новая.

    Гонка двух параллельных «добавить» упирается в частичный уникальный индекс:
    проигравший откатывается и перечитывает уже созданную корзину, а не заводит
    вторую (иначе половина товаров ушла бы в корзину-сироту)."""
    cart = get_active_cart(db, user_id)
    if cart is not None:
        return cart
    cart = Cart(user_id=user_id, status="active")
    db.add(cart)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        cart = get_active_cart(db, user_id)
        if cart is None:  # pragma: no cover — индекс сработал, но строки нет
            raise CartError("cart_conflict", "Не удалось создать корзину")
        return cart
    db.refresh(cart)
    return cart


def _owned_item(db: Session, user_id: int, item_id: int) -> CartItem:
    """Позиция из АКТИВНОЙ корзины текущего пользователя. Чужая или из уже
    отправленной корзины — «не найдено», без подсказки о том, что она есть."""
    item = db.execute(
        select(CartItem)
        .join(Cart, Cart.id == CartItem.cart_id)
        .where(
            CartItem.id == item_id,
            Cart.user_id == user_id,
            Cart.status == "active",
        )
    ).scalars().first()
    if item is None:
        raise CartError("not_found", "Позиция не найдена")
    return item


def _touch(db: Session, cart: Cart) -> None:
    """Отметить изменение корзины (``updated_at`` — критерий «заброшена»)."""
    from sqlalchemy import func as sa_func

    cart.updated_at = sa_func.now()
    db.add(cart)


# ------------------------------------------------------------- отображение ----
def _item_payload(item: CartItem, product: Product | None) -> dict:
    """Строка корзины: снапшот + АКТУАЛЬНЫЕ цена и доступность из каталога."""
    added = float(item.added_price) if item.added_price is not None else None
    if product is None:
        # Товар удалён из каталога. Позицию не прячем — пользователь должен
        # понять, что именно исчезло, а не гадать, почему сумма изменилась.
        return {
            "id": item.id,
            "product_id": item.product_id,
            "sku": item.sku,
            "title": "Товар удалён из каталога",
            "brand": None,
            "category": None,
            "image": "",
            "price": None,
            "added_price": added,
            "price_changed": False,
            "quantity": item.quantity,
            "line_total": 0.0,
            "availability_mode": "unavailable",
            "availability_label": "Недоступен",
            "availability_note": "Товар снят с продажи",
            "orderable": False,
            "max_quantity": 0,
        }

    price = float(product.price)
    avail = availability_payload(product)
    orderable = avail["orderable"]
    return {
        "id": item.id,
        "product_id": product.id,
        "sku": product.sku,
        "title": product.title,
        "brand": product.brand,
        "category": product.category,
        "image": product.image or "",
        "price": price,
        "added_price": added,
        # Сравниваем с копейками: 99990.0 и 99990.00 — одна цена.
        "price_changed": added is not None and round(added, 2) != round(price, 2),
        "quantity": item.quantity,
        "line_total": round(price * item.quantity, 2) if orderable else 0.0,
        **avail,
    }


def cart_payload(db: Session, user_id: int) -> dict:
    """Полное состояние корзины для клиента.

    Товары забираются ОДНИМ запросом по списку id — не по товару на позицию:
    корзина на 50 позиций иначе давала бы 50 запросов на каждый рендер.
    """
    cart = get_active_cart(db, user_id)
    if cart is None:
        return _empty_payload(None)

    items = sorted(cart.items, key=lambda i: i.id)
    if not items:
        return _empty_payload(cart.id)

    product_ids = [i.product_id for i in items]
    products = {
        p.id: p
        for p in db.execute(select(Product).where(Product.id.in_(product_ids))).scalars().all()
    }

    rows = [_item_payload(i, products.get(i.product_id)) for i in items]
    orderable_rows = [r for r in rows if r["orderable"]]
    return {
        "cart_id": cart.id,
        "items": rows,
        "positions_count": len(rows),
        "items_count": sum(r["quantity"] for r in orderable_rows),
        # Предварительная сумма — только по позициям, которые реально можно
        # отправить. Складывать в неё недоступный товар значит обещать цену за
        # то, чего нет.
        "estimated_total": round(sum(r["line_total"] for r in orderable_rows), 2),
        "currency": "RUB",
        "has_unavailable": any(not r["orderable"] for r in rows),
        "has_price_changes": any(r["price_changed"] for r in rows),
        "max_positions": MAX_CART_ITEMS,
    }


def _empty_payload(cart_id: int | None) -> dict:
    return {
        "cart_id": cart_id,
        "items": [],
        "positions_count": 0,
        "items_count": 0,
        "estimated_total": 0.0,
        "currency": "RUB",
        "has_unavailable": False,
        "has_price_changes": False,
        "max_positions": MAX_CART_ITEMS,
    }


# ------------------------------------------------------------- изменения ----
def add_item(db: Session, user_id: int, product_id: int, quantity: int = 1) -> CartItem:
    product = db.get(Product, product_id)
    if product is None:
        raise CartError("not_found", "Товар не найден")

    mode = resolve_availability(product)
    if not is_orderable(mode):
        raise CartError(
            "not_orderable",
            "Этот товар нельзя добавить в корзину",
            {"availability_mode": mode, "product_id": product_id},
        )

    cart = get_or_create_active_cart(db, user_id)
    existing = db.execute(
        select(CartItem).where(CartItem.cart_id == cart.id, CartItem.product_id == product_id)
    ).scalars().first()

    if existing is not None:
        existing.quantity = clamp_quantity(product, existing.quantity + max(1, quantity), mode)
        existing.sku = product.sku
        _touch(db, cart)
        db.commit()
        db.refresh(existing)
        return existing

    positions = db.execute(
        select(CartItem.id).where(CartItem.cart_id == cart.id)
    ).scalars().all()
    if len(positions) >= MAX_CART_ITEMS:
        raise CartError(
            "cart_full",
            f"В корзине уже {MAX_CART_ITEMS} позиций — больше не поместится",
            {"max_positions": MAX_CART_ITEMS},
        )

    item = CartItem(
        cart_id=cart.id,
        product_id=product_id,
        sku=product.sku,
        quantity=clamp_quantity(product, quantity, mode),
        added_price=product.price,
    )
    db.add(item)
    _touch(db, cart)
    try:
        db.commit()
    except IntegrityError:
        # Два быстрых тапа по «+» пришли параллельно: позиция уже создана
        # соседним запросом. Это не ошибка — увеличиваем количество.
        db.rollback()
        existing = db.execute(
            select(CartItem).where(CartItem.cart_id == cart.id, CartItem.product_id == product_id)
        ).scalars().first()
        if existing is None:  # pragma: no cover — конфликт был не по этой паре
            raise
        existing.quantity = clamp_quantity(product, existing.quantity + max(1, quantity), mode)
        db.commit()
        db.refresh(existing)
        return existing
    db.refresh(item)
    return item


def set_quantity(db: Session, user_id: int, item_id: int, quantity: int) -> CartItem | None:
    """Изменить количество. ``quantity <= 0`` — удалить позицию (шаг «−» на
    единице должен убирать товар, а не оставлять его в нулевом количестве)."""
    item = _owned_item(db, user_id, item_id)
    if quantity is not None and int(quantity) <= 0:
        remove_item(db, user_id, item_id)
        return None

    product = db.get(Product, item.product_id)
    if product is None:
        raise CartError("not_found", "Товар не найден")
    item.quantity = clamp_quantity(product, quantity)
    _touch(db, item.cart)
    db.commit()
    db.refresh(item)
    return item


def remove_item(db: Session, user_id: int, item_id: int) -> None:
    item = _owned_item(db, user_id, item_id)
    cart = item.cart
    db.delete(item)
    _touch(db, cart)
    db.commit()


def clear_cart(db: Session, user_id: int) -> None:
    """Очистить корзину. Идемпотентно: пустая/несуществующая — не ошибка."""
    cart = get_active_cart(db, user_id)
    if cart is None:
        return
    for item in list(cart.items):
        db.delete(item)
    _touch(db, cart)
    db.commit()


# -------------------------------------------------------------- checkout ----
def _normalize_fulfillment(value: str | None) -> str:
    v = (value or "").strip().lower()
    return v if v in DELIVERY_METHODS else "consult"


def find_lead_by_idempotency_key(db: Session, user_id: int, key: str | None) -> Lead | None:
    if not key:
        return None
    return db.execute(
        select(Lead).where(Lead.idempotency_key == key, Lead.user_id == user_id)
    ).scalars().first()


def checkout(
    db: Session,
    user,
    *,
    name: str | None,
    phone: str | None,
    fulfillment_type: str | None,
    comment: str | None,
    idempotency_key: str | None = None,
) -> tuple[Lead, bool]:
    """Превратить корзину в ОДНУ общую заявку.

    Возвращает ``(lead, created)``. ``created=False`` — заявка по этому ключу
    идемпотентности уже существует, второй раз её не создаём.

    Всё, что уходит в заявку, перепроверяется по каталогу ЗДЕСЬ: клиент мог
    показать старую цену, товар мог быть снят с публикации, количество —
    превысить лимит партии. Доверять корзине как источнику цен нельзя.
    """
    existing = find_lead_by_idempotency_key(db, user.id, idempotency_key)
    if existing is not None:
        return existing, False

    cart = get_active_cart(db, user.id)
    items = sorted(cart.items, key=lambda i: i.id) if cart else []
    if not items:
        raise CartError("empty_cart", "Корзина пуста")

    products = {
        p.id: p
        for p in db.execute(
            select(Product).where(Product.id.in_([i.product_id for i in items]))
        ).scalars().all()
    }

    problems: list[dict] = []
    lines: list[dict] = []
    for item in items:
        product = products.get(item.product_id)
        mode = resolve_availability(product)
        if product is None or not is_orderable(mode):
            problems.append({
                "item_id": item.id,
                "product_id": item.product_id,
                "title": product.title if product else None,
                "availability_mode": mode,
            })
            continue
        quantity = clamp_quantity(product, item.quantity, mode)
        price = float(product.price)
        lines.append({
            "item": item,
            "product": product,
            "mode": mode,
            "quantity": quantity,
            "price": price,
            "line_total": round(price * quantity, 2),
        })

    if problems:
        # Частичная ошибка валидации: заявку не создаём и корзину НЕ трогаем —
        # пользователь должен сам решить, удалить позицию или написать менеджеру.
        raise CartError(
            "items_unavailable",
            "Часть товаров стала недоступна — обновите корзину",
            {"items": problems},
        )

    estimated_total = round(sum(l["line_total"] for l in lines), 2)
    fulfillment = _normalize_fulfillment(fulfillment_type)

    lead = Lead(
        user_id=user.id,
        telegram_id=user.telegram_id,
        name=(name or "").strip() or user.first_name,
        phone=(phone or "").strip() or None,
        username=user.username,
        product_id=None,
        # Одиночные заявки показываются в дашборде/«Моих заявках» по
        # product_title. У корзины товара «одного» нет, поэтому кладём
        # человекочитаемое резюме — иначе везде было бы пустое «Консультация».
        product_title=_cart_title(lines),
        product_price=None,
        message=(comment or "").strip() or None,
        source=CART_LEAD_SOURCE,
        lead_type=CART_LEAD_TYPE,
        meta={"origin": "cart", "positions": len(lines)},
        delivery_method=fulfillment,
        items_count=sum(l["quantity"] for l in lines),
        estimated_total=estimated_total,
        currency="RUB",
        idempotency_key=idempotency_key or None,
        status="new",
    )
    db.add(lead)
    db.flush()  # нужен lead.id для позиций — но НЕ commit: транзакция одна

    for line in lines:
        product = line["product"]
        db.add(LeadItem(
            lead_id=lead.id,
            product_id=product.id,
            sku_snapshot=product.sku,
            title_snapshot=product.title,
            price_snapshot=line["price"],
            quantity=line["quantity"],
            line_total=line["line_total"],
            availability_snapshot=line["mode"],
            image_snapshot=(product.image or "")[:500] or None,
        ))

    # Корзина закрывается ТОЛЬКО вместе с успешно созданной заявкой. Новая
    # активная корзина создастся лениво при следующем добавлении.
    cart.status = "converted"
    db.add(cart)

    try:
        db.commit()
    except IntegrityError:
        # Гонка двойного submit: вторая попытка упёрлась в уникальный
        # idempotency_key. Заявка уже создана первой — возвращаем её.
        db.rollback()
        duplicate = find_lead_by_idempotency_key(db, user.id, idempotency_key)
        if duplicate is not None:
            return duplicate, False
        raise

    db.refresh(lead)
    return lead, True


def _cart_title(lines: list[dict]) -> str:
    """Короткое резюме заявки для списков, где место под одну строку."""
    count = len(lines)
    first = lines[0]["product"].title if lines else ""
    if count == 1:
        return first[:300]
    return f"Корзина: {first} и ещё {count - 1}"[:300]
