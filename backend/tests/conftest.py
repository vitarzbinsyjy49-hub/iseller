"""Тестовая инфраструктура backend (v5).

sqlite in-memory вместо PostgreSQL: модели совместимы (JSON/Numeric),
create_all достаточно — прод-миграции (ALTER ...) в тестах не нужны.
env задаём ДО импорта app.* — Settings требует обязательные поля.
"""
import os

os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("ADMIN_EMAIL", "admin@test.local")
os.environ.setdefault("ADMIN_PASSWORD", "test-password")
os.environ.setdefault("DEV_MODE", "true")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.models.product import Product  # noqa: F401 — регистрация таблицы


@pytest.fixture()
def db() -> Session:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def make_product(db: Session, **kw) -> Product:
    defaults = dict(
        title="iPhone 16 Pro 256 ГБ", brand="Apple", category="смартфоны",
        price=119990, in_stock=True, stock=5, popularity=10, rating=4.8,
        is_active=True, condition="new",
    )
    defaults.update(kw)
    p = Product(**defaults)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p
