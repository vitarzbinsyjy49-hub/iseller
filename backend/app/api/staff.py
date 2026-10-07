"""Режим администратора Mini App: вход с подтверждением в боте и быстрая правка цен.

Отдельно от админки сайта (api/admin*.py, вход по паролю): здесь администратор —
это Telegram-аккаунт из ADMIN_TELEGRAM_IDS, и он правит цены прямо из магазина.
Схема входа — services/staff_auth.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import bearer, client_ip, get_current_user
from app.core.rate_limit import check_rate_limit
from app.core.security import _create_token, decode_token
from app.db.session import get_db
from app.models.audit import AuditLog
from app.models.price_change import PriceChange
from app.models.product import Product
from app.models.user import User
from app.services import price_history, staff_auth

router = APIRouter(prefix="/staff", tags=["staff"])

#: Изменение цены больше этой доли требует явного «точно?» — опечатка лишнего
#: нуля или пропущенной цифры не должна уехать покупателям одним касанием.
BIG_CHANGE = 0.30
MIN_PRICE, MAX_PRICE = 1, 50_000_000


# ------------------------------------------------------------------ вход ----
def get_current_staff(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> int:
    """telegram_id администратора из staff-токена. Список админов проверяется
    на КАЖДОМ запросе: убрали человека из .env — его токен перестал работать."""
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        subject = decode_token(creds.credentials, "staff")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Staff session expired")
    if not subject.startswith("staff:"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token subject")
    tg_id = int(subject.removeprefix("staff:"))
    if not staff_auth.is_admin(tg_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not an administrator")
    return tg_id


@router.get("/eligible")
def eligible(user: User = Depends(get_current_user)) -> dict:
    """Показывать ли строку «Режим администратора». Сам вход это не открывает."""
    return {"eligible": staff_auth.is_admin(user.telegram_id)}


@router.post("/login")
def login_start(request: Request, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)) -> dict:
    ip = client_ip(request)
    if not check_rate_limit(f"staff_login:{user.telegram_id}", 5, window_seconds=300):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток, подождите")
    if not staff_auth.is_admin(user.telegram_id):
        db.add(AuditLog(actor=f"tg:{user.telegram_id}", action="staff_login_denied", ip=ip))
        db.commit()
        owner = next(iter(sorted(staff_auth.allowed_ids())), None)
        if owner:
            staff_auth.notify(owner, f"⚠️ Попытка входа в режим администратора от чужого аккаунта: "
                                     f"tg {user.telegram_id}, IP {ip}.")
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not an administrator")

    row, nonce = staff_auth.create_login(db, int(user.telegram_id), ip)
    link = staff_auth.confirm_link(nonce)
    if link is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "BOT_USERNAME is not configured")
    db.add(AuditLog(actor=f"tg:{user.telegram_id}", action="staff_login_requested", ip=ip))
    db.commit()
    when = datetime.now(timezone(timedelta(hours=3))).strftime("%H:%M")
    sent = staff_auth.notify(
        int(user.telegram_id),
        f"🔐 <b>Вход в режим администратора</b>\n\nЗапрос из приложения в {when} (МСК), IP {ip}.\n"
        "Если это вы — нажмите «Подтвердить». Ссылка действует 5 минут.\n"
        "Если это не вы — ничего не нажимайте и напишите разработчику.",
        ("✅ Подтвердить вход", link),
    )
    return {"request_id": row.request_id, "sent": sent, "ttl_seconds": int(staff_auth.LOGIN_TTL.total_seconds())}


@router.get("/login/{request_id}")
def login_poll(request_id: str, request: Request, user: User = Depends(get_current_user),
               db: Session = Depends(get_db)) -> dict:
    state = staff_auth.claim(db, request_id, int(user.telegram_id or 0))
    if state != "approved":
        db.commit()
        return {"status": state}
    token = _create_token(f"staff:{user.telegram_id}", "staff", staff_auth.STAFF_TOKEN_TTL)
    db.add(AuditLog(actor=f"tg:{user.telegram_id}", action="staff_login", ip=client_ip(request)))
    db.commit()
    return {"status": "approved", "token": token,
            "expires_in": int(staff_auth.STAFF_TOKEN_TTL.total_seconds())}


@router.post("/login/resume")
def login_resume(request: Request, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)) -> dict:
    """Войти по уже нажатому в боте подтверждению, если окно приложения закрывали."""
    if not staff_auth.is_admin(user.telegram_id) or not staff_auth.resume(db, int(user.telegram_id)):
        db.commit()
        return {"status": "none"}
    token = _create_token(f"staff:{user.telegram_id}", "staff", staff_auth.STAFF_TOKEN_TTL)
    db.add(AuditLog(actor=f"tg:{user.telegram_id}", action="staff_login", detail="resume",
                    ip=client_ip(request)))
    db.commit()
    return {"status": "approved", "token": token,
            "expires_in": int(staff_auth.STAFF_TOKEN_TTL.total_seconds())}


# ---------------------------------------------------------------- товары ----
def _last_changes(db: Session, ids: list[int]) -> dict[int, datetime]:
    if not ids:
        return {}
    rows = db.execute(select(PriceChange.product_id, func.max(PriceChange.created_at))
                      .where(PriceChange.product_id.in_(ids))
                      .group_by(PriceChange.product_id)).all()
    return {pid: ts for pid, ts in rows}


def _row(p: Product, changed: datetime | None) -> dict:
    return {
        "id": p.id, "sku": p.sku, "title": p.title, "brand": p.brand,
        "category": p.category, "price": float(p.price) if p.price is not None else None,
        "in_stock": bool(p.in_stock), "is_active": bool(p.is_active), "image": p.image,
        "price_changed_at": changed.isoformat() if changed else None,
    }


@router.get("/products")
def list_products(q: str = "", filter: str = Query("all", pattern="^(all|in_stock|out_of_stock|recent)$"),
                  limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                  _staff: int = Depends(get_current_staff), db: Session = Depends(get_db)) -> dict:
    stmt = select(Product).where(Product.is_active.is_(True))
    q = q.strip()
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Product.title.ilike(like), Product.sku.ilike(like)))
    if filter == "in_stock":
        stmt = stmt.where(Product.in_stock.is_(True))
    elif filter == "out_of_stock":
        stmt = stmt.where(Product.in_stock.is_(False))
    elif filter == "recent":
        since = datetime.now(timezone.utc) - timedelta(days=7)
        recent_ids = select(PriceChange.product_id).where(PriceChange.created_at >= since)
        stmt = stmt.where(Product.id.in_(recent_ids))
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    items = db.execute(stmt.order_by(Product.category, Product.title, Product.id)
                       .limit(limit).offset(offset)).scalars().all()
    changed = _last_changes(db, [p.id for p in items])
    return {"total": total, "items": [_row(p, changed.get(p.id)) for p in items]}


class ProductPatch(BaseModel):
    price: float | None = Field(default=None)
    in_stock: bool | None = None
    confirm: bool = False


def _get(db: Session, product_id: int) -> Product:
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    return product


def _apply_price(db: Session, product: Product, new_price: float, *, staff: int,
                 confirm: bool, note: str | None = None) -> None:
    new_price = round(float(new_price))
    if not (MIN_PRICE <= new_price <= MAX_PRICE):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Цена вне допустимого диапазона")
    old = float(product.price or 0)
    if old and abs(new_price - old) / old > BIG_CHANGE and not confirm:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={
            "code": "need_confirm", "old_price": old, "new_price": new_price,
            "change_pct": round((new_price - old) / old * 100)})
    price_history.attribute(db, actor=f"tg:{staff}", source="staff", note=note)
    product.price = new_price


@router.patch("/products/{product_id}")
def patch_product(product_id: int, body: ProductPatch, request: Request,
                  staff: int = Depends(get_current_staff), db: Session = Depends(get_db)) -> dict:
    product = _get(db, product_id)
    details = []
    if body.price is not None and round(float(body.price)) != round(float(product.price or 0)):
        old = float(product.price or 0)
        _apply_price(db, product, body.price, staff=staff, confirm=body.confirm)
        details.append(f"price {old:.0f}->{float(product.price):.0f}")
    if body.in_stock is not None and bool(body.in_stock) != bool(product.in_stock):
        product.in_stock = body.in_stock
        details.append(f"in_stock={body.in_stock}")
    if details:
        db.add(AuditLog(actor=f"tg:{staff}", action="staff_product_updated",
                        detail=f"product={product.id};sku={product.sku};" + ";".join(details),
                        ip=client_ip(request)))
    db.commit()
    db.refresh(product)
    return _row(product, _last_changes(db, [product.id]).get(product.id))


@router.get("/products/{product_id}/history")
def product_history(product_id: int, _staff: int = Depends(get_current_staff),
                    db: Session = Depends(get_db)) -> dict:
    _get(db, product_id)
    rows = db.execute(select(PriceChange).where(PriceChange.product_id == product_id)
                      .order_by(PriceChange.created_at.desc(), PriceChange.id.desc()).limit(50)).scalars().all()
    return {"items": [r.to_dict() for r in rows]}


@router.post("/products/{product_id}/revert/{change_id}")
def revert(product_id: int, change_id: int, request: Request,
           staff: int = Depends(get_current_staff), db: Session = Depends(get_db)) -> dict:
    product = _get(db, product_id)
    change = db.get(PriceChange, change_id)
    if change is None or change.product_id != product.id or change.old_price is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Change not found")
    # Откат — осознанное действие с явной целью, порог «точно?» к нему не применяем.
    _apply_price(db, product, float(change.old_price), staff=staff, confirm=True,
                 note=f"откат изменения #{change.id}")
    db.add(AuditLog(actor=f"tg:{staff}", action="staff_price_reverted",
                    detail=f"product={product.id};change={change.id}", ip=client_ip(request)))
    db.commit()
    db.refresh(product)
    return _row(product, _last_changes(db, [product.id]).get(product.id))
