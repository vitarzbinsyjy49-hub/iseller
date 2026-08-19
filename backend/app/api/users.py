from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import UserOut

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.post("/onboarding-seen", response_model=UserOut)
def mark_onboarding_seen(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Сторис-онбординг просмотрен — без тела запроса: пользователь всегда из
    токена, чужой id принять нельзя. Идемпотентно: повторный вызов (например,
    гонка между «закрыть» и естественным завершением последнего слайда) не
    двигает уже проставленную метку."""
    if user.onboarding_seen_at is None:
        user.onboarding_seen_at = func.now()
        db.commit()
        db.refresh(user)
    return user
