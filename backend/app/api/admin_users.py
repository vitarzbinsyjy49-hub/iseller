"""Раздел «Клиенты» админки: счёт лояльности и операции по нему.

До этого патча админка не знала о пользователях ничего, кроме счётчика
``users_total`` на дашборде. Здесь появляется список, карточка и ЕДИНСТВЕННЫЙ
способ изменить баланс — провести операцию в журнале.

Ручки «поставить баланс = N» нет намеренно: баланс — следствие журнала, а не
поле. Обнуление проводится корректировкой с комментарием, и через год видно,
кто и зачем.
"""
import logging

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.audit import AuditLog
from app.models.lead import Lead
from app.models.user import User
from app.services import loyalty

logger = logging.getLogger("techshop.admin.users")
router = APIRouter(prefix="/admin", tags=["admin-users"], dependencies=[Depends(get_current_admin)])

SORTS = {
    "balance": "balance",
    "spent": "lifetime_spent",
    "recent": "recent",
}


def _row(user: User, stats: dict) -> dict:
    level = loyalty.level_for(stats["lifetime_spent"])
    return {
        "id": user.id,
        "telegram_id": user.telegram_id,
        "username": user.username,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "name": " ".join(filter(None, [user.first_name, user.last_name])) or None,
        "role": user.role,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "last_seen_at": user.last_seen_at.isoformat() if user.last_seen_at else None,
        # Каким рекламным каналом привели (ad_<канал>) — None у органики и у
        # всех, кто пришёл до этого патча.
        "acquisition_source": user.acquisition_source,
        "balance": stats["balance"],
        "lifetime_spent": stats["lifetime_spent"],
        "level": level.to_dict(),
    }


@router.get("/users")
def list_users(
    db: Session = Depends(get_db),
    q: str | None = None,
    source: str | None = None,
    sort: str = "recent",
    limit: int = 100,
    offset: int = 0,
):
    """Список клиентов со счётом.

    Баланс и оборот считаются ОДНИМ GROUP BY на страницу (`loyalty.totals`), а
    не запросом на строку: сотня клиентов иначе означала бы сотню запросов.
    Сортировка по деньгам делается уже в Python — страница ограничена сотней
    строк, а join с агрегатом ради этого усложнил бы выборку без выигрыша.
    """
    limit = max(1, min(limit, 500))
    stmt = select(User)
    if source and source.strip():
        # Точное совпадение: source — код кампании ("ad_moskvatoday"), не текст
        # для нечёткого поиска, опечатка в фильтре не должна тихо вернуть 0.
        stmt = stmt.where(User.acquisition_source == source.strip())
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(func.coalesce(User.username, "")).like(needle),
                func.lower(func.coalesce(User.first_name, "")).like(needle),
                func.lower(func.coalesce(User.last_name, "")).like(needle),
                cast(User.telegram_id, String).like(needle),
            )
        )
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    users = db.execute(
        stmt.order_by(User.last_seen_at.desc(), User.id.desc()).limit(limit).offset(offset)
    ).scalars().all()

    stats = loyalty.totals(db, [u.id for u in users])
    rows = [_row(u, stats[u.id]) for u in users]
    if SORTS.get(sort) == "balance":
        rows.sort(key=lambda r: r["balance"], reverse=True)
    elif SORTS.get(sort) == "lifetime_spent":
        rows.sort(key=lambda r: r["lifetime_spent"], reverse=True)
    return {"users": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/users/{user_id}")
def user_detail(user_id: int, db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    stats = loyalty.summary(db, user_id)
    data = _row(user, stats)
    data["progress"] = {
        "next_level": stats["next_level"],
        "to_next": stats["to_next"],
        "ratio": stats["ratio"],
    }
    data["history"] = loyalty.history(db, user_id, limit=loyalty.MAX_HISTORY)
    leads = db.execute(
        select(Lead).where(Lead.user_id == user_id).order_by(Lead.id.desc()).limit(20)
    ).scalars().all()
    data["leads"] = [l.to_dict() for l in leads]
    data["levels"] = loyalty.levels_public()
    return data


@router.post("/users/{user_id}/loyalty", status_code=status.HTTP_201_CREATED)
def add_loyalty(
    user_id: int,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    """Провести операцию по счёту: покупка, списание, бонус, корректировка.

    Одна ручка на все виды — различает по ``kind``. Разные ручки на каждый вид
    означали бы четыре копии одних и тех же проверок баланса и знака.
    """
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    kind = str(body.get("kind") or "").strip()
    points = body.get("points")
    amount = body.get("amount")
    try:
        points = int(points) if points is not None and points != "" else None
        amount = float(amount) if amount is not None and amount != "" else None
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "points и amount должны быть числами")

    try:
        row = loyalty.record(
            db,
            user_id=user_id,
            kind=kind,
            points=points,
            amount=amount,
            comment=body.get("comment"),
            created_by=admin,
            idempotency_key=(body.get("idempotency_key") or None),
        )
    except loyalty.LoyaltyError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))

    # Журналируем ДО commit: операция и её след — одно изменение.
    db.add(AuditLog(
        actor=f"admin:{admin}",
        action="loyalty_transaction",
        detail=f"user={user_id};kind={row.kind};points={row.points};amount={row.amount}",
    ))
    db.commit()
    db.refresh(row)
    return {"transaction": row.to_dict(), **loyalty.summary(db, user_id)}


@router.get("/loyalty/levels")
def loyalty_levels():
    """Лестница уровней. Админка не держит свою копию — иначе она разъедется
    с бэкендом ровно так же, как когда-то список категорий."""
    return {"levels": loyalty.levels_public()}
