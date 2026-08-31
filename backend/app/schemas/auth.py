from datetime import datetime

from pydantic import BaseModel


class TelegramAuthIn(BaseModel):
    init_data: str
    # start_param диплинка (t.me/<bot>/<app>?startapp=<payload>), если Mini App
    # был открыт по рекламной/реферальной ссылке. Опционален и ни на что не
    # влияет в самой авторизации — читается один раз при СОЗДАНИИ пользователя,
    # чтобы записать источник первого прихода (см. app/api/auth.py).
    start_param: str | None = None


class AdminLoginIn(BaseModel):
    email: str
    password: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshIn(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    id: int
    telegram_id: int
    username: str | None
    first_name: str | None
    last_name: str | None
    photo_url: str | None
    role: str
    onboarding_seen_at: datetime | None
    acquisition_source: str | None

    class Config:
        from_attributes = True
