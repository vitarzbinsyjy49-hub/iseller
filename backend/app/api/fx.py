"""GET /api/fx/history — история курса USD для графика в шторке «Курс и цены».

Без авторизации: обычный рыночный курс, не персональные данные. Дёргается
фронтом лениво (только при открытии шторки), поэтому отдельный от
/config/public эндпоинт — не грузим историю на каждой загрузке главной.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services import fx_rate

router = APIRouter(prefix="/fx", tags=["fx"])


@router.get("/history")
def get_history(
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
):
    return {"history": fx_rate.history(db, days)}
