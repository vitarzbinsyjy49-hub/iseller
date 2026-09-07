"""«Кто кого привёл» — наблюдаемость реферальной программы.

GET /api/admin/referrals — пары «пригласивший — приглашённый» с числом
завершённых сделок и суммой выплат, отсортированные по выплатам вниз.

Сортировка по сумме не для красоты: накрутка всплывает наверх сама, без
отдельного детектора. Никакой код не отличит настоящую покупку от проведённой
по просьбе (см. спеку, §5.3) — эти меры дают видимость, а не автоматику.

Считается ТРЕМЯ запросами на весь список, а не запросом на строку: тот же
приём, что в loyalty.totals и apply_social_proof.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.lead import Lead
from app.models.loyalty import LoyaltyTransaction
from app.models.user import User

router = APIRouter(prefix="/admin", tags=["admin"])

MAX_ROWS = 500


def _person(user: User) -> dict:
    return {
        "id": user.id,
        "telegram_id": user.telegram_id,
        "username": user.username,
        "name": " ".join(filter(None, [user.first_name, user.last_name])) or None,
    }


@router.get("/referrals")
def list_referrals(
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    inviter = aliased(User)
    pairs = db.execute(
        select(User, inviter)
        .join(inviter, User.referred_by_user_id == inviter.id)
        .order_by(User.created_at.desc(), User.id.desc())
        .limit(MAX_ROWS)
    ).all()
    if not pairs:
        return {"items": []}

    invited_ids = [invited.id for invited, _ in pairs]

    # Завершённых сделок у приглашённого — по самим заявкам, а не по журналу:
    # заявку могли завершить, когда автоначисление было выключено рубильником.
    completed = dict(db.execute(
        select(Lead.user_id, func.count())
        .where(Lead.user_id.in_(invited_ids), Lead.status == "completed")
        .group_by(Lead.user_id)
    ).all())

    # Выплачено пригласившему ЗА ЭТОГО приглашённого напрямую посчитать нечем:
    # операция знает получателя, а не того, с чьей покупки она пришла. Поэтому
    # сумма считается по паре через ключ идемпотентности заявок приглашённого —
    # он содержит номер заявки (см. referral.referral_key).
    lead_ids = dict(db.execute(
        select(Lead.id, Lead.user_id).where(Lead.user_id.in_(invited_ids))
    ).all())
    paid: dict[int, int] = {}
    if lead_ids:
        rows = db.execute(
            select(LoyaltyTransaction.idempotency_key, LoyaltyTransaction.points).where(
                LoyaltyTransaction.kind == "referral",
                LoyaltyTransaction.rate_bps.is_not(None),
            )
        ).all()
        for key, points in rows:
            # lead_<id>_<seq>_referral
            parts = (key or "").split("_")
            if len(parts) < 2 or parts[0] != "lead" or not parts[1].isdigit():
                continue
            buyer = lead_ids.get(int(parts[1]))
            if buyer is not None:
                paid[buyer] = paid.get(buyer, 0) + int(points)

    items = [
        {
            "inviter": _person(inv),
            "invited": _person(invited),
            "registered_at": invited.created_at.isoformat() if invited.created_at else None,
            "completed_leads": int(completed.get(invited.id, 0)),
            "paid_points": int(paid.get(invited.id, 0)),
        }
        for invited, inv in pairs
    ]
    items.sort(key=lambda r: (-r["paid_points"], -r["completed_leads"], r["invited"]["id"]))
    return {"items": items}
