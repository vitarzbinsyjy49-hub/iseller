import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.core.logging import setup_logging
from app.core.uploads import UPLOAD_DIR
from app.db.session import Base, engine
from app.api import admin, admin_crm, admin_promo, admin_users, ai, auth, cart, catalog, config as config_api, events, favorites, health, home, imports, leads, loyalty, posts, price_posts, telegram, users

# Регистрация таблиц в metadata до create_all (Demo MVP)
from app.models import analytics_event as _analytics_event  # noqa: F401
from app.models import cart as _cart  # noqa: F401
from app.models import favorite as _favorite  # noqa: F401
from app.models import lead_item as _lead_item  # noqa: F401
from app.models import home as _home  # noqa: F401
from app.models import lead as _lead  # noqa: F401
from app.models import loyalty as _loyalty  # noqa: F401
from app.models import notification as _notification  # noqa: F401
from app.models import product as _product  # noqa: F401
from app.models import promo as _promo  # noqa: F401
from app.models import product_image_group as _product_image_group  # noqa: F401
from app.models import revoked_token as _revoked_token  # noqa: F401
from app.models import user_product_event as _user_product_event  # noqa: F401
from app.models import post as _post  # noqa: F401

setup_logging()
logger = logging.getLogger("techshop")

# Swagger/OpenAPI — только в DEV_MODE. В проде схема API наружу не публикуется:
# она перечисляет все админские маршруты и формы тел запросов, что упрощает
# разведку. Внутри контейнера схема по-прежнему доступна коду (app.openapi()).
_DOCS = {"docs_url": "/api/docs", "openapi_url": "/api/openapi.json", "redoc_url": "/api/redoc"} \
    if settings.DEV_MODE else {"docs_url": None, "openapi_url": None, "redoc_url": None}

app = FastAPI(title="AI Seller API", version="1.0.0", **_DOCS)


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
app.include_router(favorites.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
# Sprint 1.5: Integration Layer (AI + каталог + аналитика)
app.include_router(ai.router, prefix="/api")
app.include_router(catalog.router, prefix="/api")
app.include_router(events.router, prefix="/api")
# Demo MVP: CRM (заявки) + расширенная админка
app.include_router(leads.router, prefix="/api")
# Compact Home + Cart: корзина Mini App и общая заявка по ней
app.include_router(cart.router, prefix="/api")
app.include_router(admin_crm.router, prefix="/api")
# v5.8.0: лояльность — счёт покупателя и раздел «Клиенты» в админке
app.include_router(loyalty.router, prefix="/api")
app.include_router(admin_users.router, prefix="/api")
# Промокоды: акция на первые заказы, купон списывается только оформлением
app.include_router(admin_promo.router, prefix="/api")
# v4: управляемая главная + Import Center + публичная конфигурация
app.include_router(home.router, prefix="/api")
app.include_router(home.admin_router, prefix="/api")
app.include_router(imports.router, prefix="/api")
app.include_router(config_api.router, prefix="/api")
app.include_router(posts.router, prefix="/api")
# v5.6.0: постоянные прайс-посты канала (генерация, diff, публикация, навигация)
app.include_router(price_posts.router, prefix="/api")
# v5.5.0: приём апдейтов Telegram-бота (вебхук, защищён secret_token)
app.include_router(telegram.router, prefix="/api")

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
        # v5.4.0: сценарные заявки. Обратносовместимо — у старых заявок lead_type
        # проставится дефолтом 'general', metadata пустым объектом.
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_type VARCHAR(32) DEFAULT 'general'",
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS metadata JSON DEFAULT '{}'::json",
        "CREATE INDEX IF NOT EXISTS ix_leads_lead_type ON leads (lead_type)",
        "UPDATE leads SET lead_type = 'general' WHERE lead_type IS NULL",
        # Compact Home + Cart: общая заявка по корзине. Все колонки новые и
        # необязательные — существующие одиночные заявки остаются как есть
        # (items_count=0, estimated_total/idempotency_key = NULL), массовой
        # конвертации нет и быть не должно. Таблицы carts/cart_items/lead_items
        # создаёт create_all; здесь только доводка leads и products.
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS items_count INTEGER DEFAULT 0",
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS estimated_total NUMERIC(12, 2)",
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS currency VARCHAR(8) DEFAULT 'RUB'",
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64)",
        "UPDATE leads SET items_count = 0 WHERE items_count IS NULL",
        # Уникальность ключа идемпотентности — на уровне БД: только она делает
        # двойной submit безопасным при параллельных запросах. Ключ уникален В
        # ПРЕДЕЛАХ пользователя, иначе чужой клиент мог бы занять значение.
        "CREATE INDEX IF NOT EXISTS ix_leads_idempotency_key ON leads (idempotency_key)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_user_idempotency ON leads (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL",
        # Режим доступности товара. NULL = выводится из in_stock/is_limited,
        # то есть поведение существующих 217 товаров не меняется ни на шаг.
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS availability_mode VARCHAR(20)",
        # v5.8: «легендарный» товар — редкая позиция, закреплённая наверху выдачи
        # и помеченная золотом на карточке. DEFAULT FALSE: у существующих 215
        # товаров ничего не меняется, флаг ставится вручную в админке.
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS is_legendary BOOLEAN NOT NULL DEFAULT FALSE",
        # Афиша события: широкий макет для страницы товара. Отдельно от images,
        # потому что в квадратной карточке ленты постер обрезался бы по центру,
        # теряя и заголовок, и цену. NULL у всех, кроме единичных позиций.
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS poster_url TEXT",
        # Патч 1.1: отметки «что про этот товар пользователь уже слышал».
        # NULL у существующих строк — сознательно: первый скан их заполнит и
        # промолчит, иначе выкладка разослала бы всем всё про всё избранное.
        "ALTER TABLE product_favorites ADD COLUMN IF NOT EXISTS notified_price NUMERIC(12, 2)",
        "ALTER TABLE product_favorites ADD COLUMN IF NOT EXISTS notified_in_stock BOOLEAN",
        # v5.6.0: постоянные прайс-посты канала. Все поля необязательные —
        # существующие новостные посты продолжают работать без изменений.
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS slug VARCHAR(64)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_channel_posts_slug ON channel_posts (slug)",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS channel_id VARCHAR(64)",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS catalog_fingerprint VARCHAR(64)",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS last_generated_at TIMESTAMPTZ",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS item_count INTEGER DEFAULT 0",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS reply_markup JSON",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS last_error TEXT",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS published_body TEXT",
        "ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS button_spec JSON",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSON DEFAULT '[]'::json",
        # v5.5.0: «Осталось N шт» показываем только у явно лимитированных товаров.
        # Дефолт false => у существующих позиций подпись просто исчезает; сами
        # складские остатки (stock) не меняются.
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS is_limited BOOLEAN DEFAULT false",
        "UPDATE products SET is_limited = false WHERE is_limited IS NULL",
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
        # v5.2.6: канонические группы изображений (модель+цвет). Не удаляют
        # существующие image/images — это дополнительный слой поверх них.
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS model_family VARCHAR(120)",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS image_group_detached BOOLEAN DEFAULT false",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS image_group_key VARCHAR(255)",
        "CREATE INDEX IF NOT EXISTS ix_products_image_group_key ON products (image_group_key)",
        "CREATE INDEX IF NOT EXISTS ix_products_sku ON products (sku)",
        # Перенос sku из specs (так его хранил старый импорт) в новую колонку
        "UPDATE products SET sku = specs->>'sku' WHERE sku IS NULL AND specs->>'sku' IS NOT NULL",
        # pre-launch: sku канонизируем в верхний регистр (ключ импорта/матчинга фото)
        "UPDATE products SET sku = upper(trim(sku)) WHERE sku IS NOT NULL AND sku <> upper(trim(sku))",
        # Аватар из Telegram initData вместо инициалов в чипе профиля. NULL у
        # уже существующих пользователей — заполнится следующим их входом
        # (auth_telegram пишет photo_url при каждом логине), досрочно ничего
        # не дозаполняем.
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url VARCHAR(512)",
        # telegram_id заявки был 32-битным INTEGER — Telegram уже выдаёт id за
        # пределами этого диапазона (например 7678374811), и INSERT падал с
        # "integer out of range" на ЛЮБОЙ заявке такого пользователя (корзина,
        # price_offer, сценарные). users.telegram_id уже BigInteger, здесь —
        # тот же тип, что и должен был быть с самого начала.
        "ALTER TABLE leads ALTER COLUMN telegram_id TYPE BIGINT",
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


def _backfill_image_group_keys() -> None:
    """v5.2.6: заполнить image_group_key у товаров, где он пуст (после ALTER —
    у всех существующих). Логика ключа — Python (title/цвет), не SQL. Идемпотентно:
    при сохранении товара ключ и так пересчитывается ORM-событием."""
    from app.db.session import SessionLocal
    from app.models.product import Product
    from app.services.image_groups import product_image_group_key
    try:
        with SessionLocal() as db:
            rows = db.query(Product).filter(Product.image_group_key.is_(None)).all()
            for p in rows:
                p.image_group_key = product_image_group_key(p)
            if rows:
                db.commit()
                logger.info("Backfilled image_group_key for %d products", len(rows))
    except Exception:  # noqa: BLE001 — бэкофилл не должен ронять старт
        logger.exception("image_group_key backfill failed")


@app.on_event("startup")
def on_startup():
    # Sprint 1: создаём таблицы напрямую. Начиная со Sprint 2 переходим на Alembic-миграции.
    Base.metadata.create_all(bind=engine)
    _apply_demo_migrations()
    _backfill_image_group_keys()
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
