import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.core.logging import setup_logging
from app.core.uploads import UPLOAD_DIR
from app.db.session import Base, engine
from app.api import admin, admin_crm, ai, auth, catalog, config as config_api, events, health, home, imports, leads, posts, users

# Регистрация таблиц в metadata до create_all (Demo MVP)
from app.models import analytics_event as _analytics_event  # noqa: F401
from app.models import home as _home  # noqa: F401
from app.models import lead as _lead  # noqa: F401
from app.models import product as _product  # noqa: F401
from app.models import post as _post  # noqa: F401

setup_logging()
logger = logging.getLogger("techshop")

app = FastAPI(title="AI Seller API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


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
# v4: управляемая главная + Import Center + публичная конфигурация
app.include_router(home.router, prefix="/api")
app.include_router(home.admin_router, prefix="/api")
app.include_router(imports.router, prefix="/api")
app.include_router(config_api.router, prefix="/api")
app.include_router(posts.router, prefix="/api")

# Раздача загруженных изображений товаров (тот же origin, что и API)
app.mount("/api/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


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
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSON DEFAULT '[]'::json",
        # v4: расширение карточки товара (импорт, характеристики, матчинг фото)
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(64)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory VARCHAR(100)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS condition VARCHAR(20) DEFAULT 'new'",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS color VARCHAR(50)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS memory VARCHAR(50)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS storage VARCHAR(50)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS screen_size VARCHAR(50)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS cpu VARCHAR(100)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS ram VARCHAR(50)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'manual'",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()",
        "CREATE INDEX IF NOT EXISTS ix_products_sku ON products (sku)",
        # Перенос sku из specs (так его хранил старый импорт) в новую колонку
        "UPDATE products SET sku = specs->>'sku' WHERE sku IS NULL AND specs->>'sku' IS NOT NULL",
        # pre-launch: sku канонизируем в верхний регистр (ключ импорта/матчинга фото)
        "UPDATE products SET sku = upper(trim(sku)) WHERE sku IS NOT NULL AND sku <> upper(trim(sku))",
    ]
    for stmt in statements:
        try:
            with engine.begin() as conn:  # отдельная транзакция на каждый ALTER
                conn.execute(text(stmt))
        except Exception:  # noqa: BLE001 — sqlite в тестах не знает IF NOT EXISTS
            logger.warning("Demo migration skipped: %s", stmt)

    # pre-launch: уникальность SKU (регистронезависимая). Сначала честно ищем
    # дубли: если они есть, индекс не создастся — пишем ПОНЯТНЫЙ лог со списком,
    # а не роняем запуск и не ломаем существующую базу молча.
    try:
        with engine.begin() as conn:
            dupes = conn.execute(text(
                "SELECT lower(sku) AS k, count(*) AS n, array_agg(id) AS ids "
                "FROM products WHERE sku IS NOT NULL GROUP BY lower(sku) HAVING count(*) > 1"
            )).fetchall()
        if dupes:
            for k, n, ids in dupes:
                logger.error(
                    "SKU-дубль '%s' у товаров id=%s (%d шт). Уникальный индекс НЕ создан. "
                    "Исправьте sku в админке (Товары -> Изменить) и перезапустите backend.",
                    k, ids, n,
                )
        else:
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_products_sku_lower "
                    "ON products (lower(sku)) WHERE sku IS NOT NULL"
                ))
    except Exception:  # noqa: BLE001 — sqlite/старый PG: без индекса, но с работающим API
        logger.warning("SKU unique index migration skipped", exc_info=True)


@app.on_event("startup")
def on_startup():
    # Sprint 1: создаём таблицы напрямую. Начиная со Sprint 2 переходим на Alembic-миграции.
    Base.metadata.create_all(bind=engine)
    _apply_demo_migrations()
    # v4: если баннеры/категории главной ещё не создавались — заполняем дефолтными
    from app.api.home import seed_home_defaults
    from app.db.session import SessionLocal
    try:
        with SessionLocal() as db:
            if seed_home_defaults(db):
                logger.info("Home banners/categories seeded with defaults")
    except Exception:  # noqa: BLE001 — сид не должен ронять API
        logger.exception("Home defaults seed failed")
    logger.info("AI Seller API started. DEV_MODE=%s", settings.DEV_MODE)
