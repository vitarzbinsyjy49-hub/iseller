"""Счёт лояльности покупателя.

GET /api/loyalty/me — баланс, уровень, ставка, прогресс, история, лестница.

Пользователь видит ТОЛЬКО свой счёт: user_id берётся из токена и в параметрах
не принимается вовсе. Принимать его «для удобства» означало бы отдавать чужой
баланс и историю покупок любому, кто подставит число.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services import loyalty

router = APIRouter(prefix="/loyalty", tags=["loyalty"])


@router.get("/me")
def my_loyalty(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    history_limit: int = 30,
):
    data = loyalty.summary(db, user.id)
    data["history"] = loyalty.history(db, user.id, limit=history_limit)
    # Лестница приходит с сервера, а не объявляется во фронте: вторая копия
    # порогов разъехалась бы с первой, и покупатель увидел бы не тот уровень,
    # по которому ему на самом деле начисляют.
    data["levels"] = loyalty.levels_public()
    return data
