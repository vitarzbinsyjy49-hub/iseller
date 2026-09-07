"""Счёт приглашений покупателя.

GET /api/referral/me — код, ссылка, сколько людей пришло, сколько принесли,
и УСЛОВИЯ: процент и приветственный бонус приходят с сервера, а не зашиты во
фронт. Настройка меняется в админке, и текст с «1%» разъехался бы с ней молча.

Свой счёт и только свой: user_id из токена, в параметрах не принимается — то
же правило, что у /loyalty/me.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings as app_settings
from app.db.session import get_db
from app.models.loyalty import LoyaltyTransaction
from app.models.user import User
from app.services import referral, settings as settings_service
from app.services.telegram_bot import REF_PAYLOAD_PREFIX

router = APIRouter(prefix="/referral", tags=["referral"])


def _link(code: str) -> str | None:
    """Ссылка ведёт в ЧАТ с ботом, а не в Mini App.

    Вход по ?startapp= не даёт боту права писать человеку: приглашённый друг
    остался бы без напоминаний о корзине и без статусов заявки — это половина
    ценности приложения.
    """
    username = (app_settings.BOT_USERNAME or "").strip().lstrip("@")
    if not username:
        return None
    return f"https://t.me/{username}?start={REF_PAYLOAD_PREFIX}{code}"


@router.get("/me")
def my_referrals(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    code = referral.code_for(db, user)
    conf = settings_service.loyalty(db)

    invited_count = db.execute(
        select(func.count()).select_from(User).where(User.referred_by_user_id == user.id)
    ).scalar_one()
    # Приветственный бонус приглашённого в доход пригласившего не входит: он
    # про друга. Различаем по rate_bps — он есть только у процента.
    earned = db.execute(
        select(func.coalesce(func.sum(LoyaltyTransaction.points), 0)).where(
            LoyaltyTransaction.user_id == user.id,
            LoyaltyTransaction.kind == "referral",
            LoyaltyTransaction.rate_bps.is_not(None),
        )
    ).scalar_one()

    return {
        "code": code,
        "link": _link(code),
        "invited_count": int(invited_count),
        "earned_points": int(earned or 0),
        "rate_percent": conf.referral_rate_bps / 100,
        "welcome_bonus_points": conf.welcome_bonus_points,
    }
