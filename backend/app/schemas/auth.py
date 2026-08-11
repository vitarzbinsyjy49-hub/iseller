from pydantic import BaseModel


class TelegramAuthIn(BaseModel):
    init_data: str


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

    class Config:
        from_attributes = True
