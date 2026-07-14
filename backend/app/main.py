import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.logging import setup_logging
from app.db.session import Base, engine
from app.api import admin, admin_crm, ai, auth, catalog, events, health, leads, users

# Регистрация таблиц в metadata до create_all (Demo MVP)
from app.models import analytics_event as _analytics_event  # noqa: F401
from app.models import lead as _lead  # noqa: F401
from app.models import product as _product  # noqa: F401

setup_logging()
logger = logging.getLogger("techshop")

app = FastAPI(title="TechShop API", version="0.2.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


def _build_cors_kwargs() -> dict:
    """CORS production guard (v2).

    DEV_MODE=true  -> удобные dev-настройки: localhost + широкий https-regex
                      (как в Sprint 1, локальная разработка не ломается).
    DEV_MODE=false -> ТОЛЬКО явный список ALLOWED_ORIGINS, без regex.
                      Пустой ALLOWED_ORIGINS в проде = ошибка конфигурации:
                      падаем на старте с понятным сообщением, а не открываем всё.
    """
    if settings.DEV_MODE:
        return {
            "allow_origins": ["http://localhost:5173", "http://localhost:5174", *settings.allowed_origins_list],
            "allow_origin_regex": r"https://.*",
            "allow_credentials": True,
            "allow_methods": ["*"],
            "allow_headers": ["*"],
        }

    origins = settings.allowed_origins_list
    if not origins:
        raise RuntimeError(
            "CORS misconfiguration: DEV_MODE=false requires a non-empty ALLOWED_ORIGINS "
            "(comma-separated, e.g. ALLOWED_ORIGINS=https://example.com,https://t.me). "
            "Refusing to start with a wide-open CORS policy in production."
        )
    return {
        "allow_origins": origins,
        "allow_origin_regex": None,  # никакого https://.* в проде
        "allow_credentials": True,
        "allow_methods": ["*"],
        "allow_headers": ["*"],
    }


app.add_middleware(CORSMiddleware, **_build_cors_kwargs())

app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
# Sprint 1.5: Integration Layer (AI + каталог + аналитика)
app.include_router(ai.router, prefix="/api")
app.include_router(catalog.router, prefix="/api")
app.include_router(events.router, prefix="/api")
# Demo MVP: CRM (заявки) + расширенная админка
app.include_router(leads.router, prefix="/api")
app.include_router(admin_crm.router, prefix="/api")


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


def _apply_demo_migrations() -> None:
    """Мини-миграции демо (v2): create_all не добавляет колонки в существующие
    таблицы, поэтому новые поля добавляем явным ALTER ... IF NOT EXISTS.
    Идемпотентно и безопасно для свежей БД."""
    from sqlalchemy import text
    statements = [
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(32)",
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_price NUMERIC(12, 2)",
    ]
    for stmt in statements:
        try:
            with engine.begin() as conn:  # отдельная транзакция на каждый ALTER
                conn.execute(text(stmt))
        except Exception:  # noqa: BLE001 — sqlite в тестах не знает IF NOT EXISTS
            logger.warning("Demo migration skipped: %s", stmt)


@app.on_event("startup")
def on_startup():
    # Sprint 1: создаём таблицы напрямую. Начиная со Sprint 2 переходим на Alembic-миграции.
    Base.metadata.create_all(bind=engine)
    _apply_demo_migrations()
    logger.info("TechShop API started. DEV_MODE=%s", settings.DEV_MODE)
