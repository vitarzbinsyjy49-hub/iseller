"""Загрузка фото к отзыву и владение заявкой — проверки уровня HTTP.

Почему отдельный файл от test_reviews.py: там проверяется сервис (что отзыв не
существует без завершённой покупки), здесь — ручка. Это разные слои, и дыры у
них разные: сервис ничего не знает ни о квотах, ни о том, чей токен пришёл.

Обе проверки ниже закрывают асимметрию с заявкой «Предложить товар». У той
загрузка фото ограничена суточной квотой, и в коде прямо написано почему:
картинки — самый дешёвый способ забить диск. К отзывам то же правило просто не
приложили, хотя ручка так же открыта любому, у кого есть Telegram-аккаунт.
"""
import io

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.core import rate_limit
from app.core.uploads import MAX_BYTES
from app.db.session import get_db
from app.main import app
from app.models.lead import Lead
from app.models.user import User


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """Окно лимитера живёт в процессе — чистим, иначе низкий лимит одного теста
    ловит запросы соседнего (все используют одного и того же пользователя)."""
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=602, first_name="Артём", username="artem")
    db.add(u)
    db.commit()
    db.refresh(u)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, u
    finally:
        app.dependency_overrides.clear()


def _photo(size: int = 100) -> dict:
    return {"file": ("photo.jpg", io.BytesIO(b"\xff\xd8\xff" + b"0" * size), "image/jpeg")}


# ---------------------------------------------------------------- квота

def test_review_photo_upload_rate_limited(ctx, monkeypatch):
    """Ручка открыта любому авторизованному — значит, у неё обязан быть потолок.

    Без него один аккаунт (а он создаётся за минуту) льёт по 8 МБ, пока на VPS
    не кончится диск: вместе с диском ложится и витрина, и бот.
    """
    client, _db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.REVIEW_PHOTO_DAILY_LIMIT_PER_USER", 1)
    ok = client.post("/api/reviews/photo", files=_photo())
    assert ok.status_code == 201
    blocked = client.post("/api/reviews/photo", files=_photo())
    assert blocked.status_code == 429


def test_review_photo_quota_is_daily_not_per_minute(ctx, monkeypatch):
    """Окно квоты — сутки, а не минута.

    Проверяется поведением, а не аргументом вызова: лимитер не хранит размер
    окна, его задаёт вызывающий код. Поэтому двигаем часы на час вперёд —
    минутное окно к этому моменту уже открылось бы, суточное нет. Перепутать
    60 с 86400 иначе никак не заметно: обе константы «работают».
    """
    client, _db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.REVIEW_PHOTO_DAILY_LIMIT_PER_USER", 1)
    assert client.post("/api/reviews/photo", files=_photo()).status_code == 201

    clock = rate_limit.time.monotonic() + 3600
    monkeypatch.setattr(rate_limit.time, "monotonic", lambda: clock)
    assert client.post("/api/reviews/photo", files=_photo()).status_code == 429


# ---------------------------------------------------------------- размер

def test_review_photo_over_limit_is_rejected(ctx):
    client, _db, _u = ctx
    big = b"\xff\xd8\xff" + b"0" * MAX_BYTES
    r = client.post("/api/reviews/photo", files={"file": ("big.jpg", io.BytesIO(big), "image/jpeg")})
    assert r.status_code == 400


def test_review_photo_rejects_non_image(ctx):
    r, _db, _u = ctx
    resp = r.post("/api/reviews/photo", files={"file": ("doc.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")})
    assert resp.status_code == 400


# ---------------------------------------------------------------- владение

def _ownerless_lead(db) -> Lead:
    """Заявка без владельца — та, что заведена не из Mini App (менеджером,
    импортом, скриптом). Модель это допускает: Lead.user_id nullable."""
    lead = Lead(
        name="Клиент по телефону", telegram_id=None, user_id=None,
        status="completed", product_title="iPhone 17 Pro", items_count=1,
        final_total=100000, completion_seq=99,
    )
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def test_review_on_ownerless_lead_is_rejected(ctx):
    """Заявка без владельца не принадлежит никому — значит, и текущему тоже.

    Прежнее условие пропускало её любому авторизованному: отзыв с бейджем
    «покупка подтверждена» мог появиться у человека, который эту покупку не
    совершал.
    """
    client, db, _u = ctx
    lead = _ownerless_lead(db)
    r = client.post(f"/api/reviews/lead/{lead.id}", json={"rating": 5, "text": "Отлично"})
    assert r.status_code == 404


def test_reading_ownerless_lead_is_rejected(ctx):
    """Чтение закрыто по той же причине: ответ несёт номер заявки, товар и
    состав — то есть чужие данные покупки."""
    client, db, _u = ctx
    lead = _ownerless_lead(db)
    r = client.get(f"/api/reviews/lead/{lead.id}")
    assert r.status_code == 404


def test_own_lead_still_readable(ctx):
    """Контрольный: ужесточение не должно задеть обычный путь."""
    client, db, u = ctx
    lead = Lead(
        name="Артём", telegram_id=602, user_id=u.id, status="completed",
        product_title="iPhone 17 Pro", items_count=1, final_total=100000,
        completion_seq=100,
    )
    db.add(lead)
    db.commit()
    db.refresh(lead)
    r = client.get(f"/api/reviews/lead/{lead.id}")
    assert r.status_code == 200
    assert r.json()["can_review"] is True
