"""Конфигурация основного backend (Integration Layer v2).

Добавлено в v2:
- AI_CHAT_RATE_LIMIT_PER_MINUTE — лимит запросов к /api/ai/chat;
- ALLOWED_ORIGINS — явный список origin для production CORS;
- канонические имена AI_ENGINE_TIMEOUT_SECONDS и CATALOG_EXPORT_API_KEY.

Обратная совместимость: старые имена AI_TIMEOUT_SECONDS и CATALOG_EXPORT_KEY
по-прежнему читаются как псевдонимы — существующие .env не ломаются.
"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ==== Публичная конфигурация витрины (v4 pre-launch) ====
    # Отдаётся наружу через GET /api/config/public — НИКАКИХ секретов здесь.
    APP_NAME: str = "AI Seller"
    MANAGER_RETAIL_URL: str = ""      # t.me-ссылка розничного менеджера
    MANAGER_WHOLESALE_URL: str = ""   # оптовые закупки (пусто => fallback на retail)
    MANAGER_B2B_URL: str = ""         # поставки компаниям (пусто => fallback на retail)
    MANAGER_TRADEIN_URL: str = ""     # trade-in / выкуп (пусто => fallback на retail)
    TELEGRAM_CHANNEL_URL: str = ""
    MINI_APP_URL: str = ""

    DATABASE_URL: str
    TELEGRAM_BOT_TOKEN: str = ""
    # @username or numeric -100... id. The bot must be a channel administrator.
    TELEGRAM_CHANNEL_ID: str = ""
    JWT_SECRET: str
    ACCESS_TOKEN_MINUTES: int = 30
    REFRESH_TOKEN_DAYS: int = 14
    ADMIN_EMAIL: str
    ADMIN_PASSWORD: str
    DEV_MODE: bool = False

    # ==== CORS (production guard, v2) ====
    # Явный список разрешённых origin через запятую, например:
    # ALLOWED_ORIGINS=https://example.com,https://t.me
    # В production (DEV_MODE=false) используется ТОЛЬКО он; пустой список
    # при DEV_MODE=false приводит к падению на старте (см. main.py).
    ALLOWED_ORIGINS: str = ""

    # ==== Интеграция с AI Engine (Sprint 1.5) ====
    # Пустые дефолты: без них проект работает как раньше, AI-роут уходит в fallback.
    AI_ENGINE_URL: str = ""            # например http://ai-engine:8090
    AI_ENGINE_API_KEY: str = ""        # = AI_ENGINE_API_KEY из .env AI Engine

    # Канонические имена (v2) + псевдонимы для обратной совместимости (v1).
    AI_ENGINE_TIMEOUT_SECONDS: float = 20.0   # локальная Ollama на CPU может думать долго
    AI_TIMEOUT_SECONDS: float | None = None   # DEPRECATED-псевдоним AI_ENGINE_TIMEOUT_SECONDS

    CATALOG_EXPORT_API_KEY: str = ""   # ключ, с которым AI Engine забирает каталог
    CATALOG_EXPORT_KEY: str = ""       # DEPRECATED-псевдоним CATALOG_EXPORT_API_KEY

    # ==== Rate limit на /api/ai/chat (v2) ====
    AI_CHAT_RATE_LIMIT_PER_MINUTE: int = 10
    # Необязательный Redis для распределённого лимита. Пусто => in-memory (per-process),
    # чего достаточно для одного инстанса backend. Недоступность Redis => мягкая
    # деградация на in-memory, backend не падает (см. core/rate_limit.py).
    RATE_LIMIT_REDIS_URL: str = ""

    # ==== Режим AI для демо ====
    # fallback | mock — не обращаться к AI Engine, отвечать по каталогу (быстро, без ключей);
    # ai            — legacy AI Engine (docker profile ai);
    # ollama_remote — локальный AI-консультант через AI Gateway на Mac mini (v5).
    # Демо по умолчанию = fallback, чтобы не зависеть от Ollama/ключей.
    AI_PROVIDER: str = "fallback"

    # ==== Локальный AI-консультант через AI Gateway (v5) ====
    # Gateway живёт на Mac mini (Ollama), доступен по приватной сети (Tailscale и т.п.).
    AI_GATEWAY_URL: str = ""           # например http://100.64.0.2:8100
    AI_GATEWAY_API_KEY: str = ""       # общий секрет VPS <-> Gateway
    AI_MAX_HISTORY_MESSAGES: int = 10  # сколько последних сообщений диалога отправлять
    AI_MAX_PRODUCT_CANDIDATES: int = 12  # максимум товаров-кандидатов в контекст LLM
    AI_FALLBACK_ENABLED: bool = True   # при недоступности Gateway отвечать fallback'ом
    AI_SYSTEM_PROMPT_VERSION: str = "v2"  # версия файла app/prompts/ai_seller_system_<v>.md
    # Таймаут запроса VPS->Gateway (v5.1.1). Полный запрос на gateway может занять
    # queue wait (до 10с) + inference (до 45с) + сетевой overhead, поэтому здесь
    # 65с; таймаут фронтенда (75с) — больше этого.
    AI_GATEWAY_TIMEOUT_SECONDS: float = 65.0

    # ==== Batch Import Center (v5.2) ====
    IMPORT_MAX_FILES: int = 30                       # файлов в одном пакете
    IMPORT_MAX_TOTAL_ROWS: int = 5000                # суммарно строк во всех файлах
    IMPORT_MAX_DATA_FILE_BYTES: int = 20971520       # 20 МБ на data-файл
    IMPORT_MAX_ZIP_BYTES: int = 524288000            # 500 МБ на ZIP
    IMPORT_MAX_UNCOMPRESSED_BYTES: int = 1073741824  # 1 ГБ распакованного
    IMPORT_JOB_TTL_SECONDS: int = 1800               # 30 минут на confirm
    IMPORT_MAX_IMAGES: int = 5000                    # изображений в пакете
    IMPORT_PRICE_CHANGE_WARN_PCT: float = 30.0       # warning при изменении цены > N%

    class Config:
        env_file = ".env"
        extra = "ignore"

    # ---- Разрешение псевдонимов (старое имя побеждает, только если новое осталось дефолтным) ----
    @property
    def ai_engine_timeout_seconds(self) -> float:
        if self.AI_TIMEOUT_SECONDS is not None:
            return self.AI_TIMEOUT_SECONDS
        return self.AI_ENGINE_TIMEOUT_SECONDS

    @property
    def catalog_export_api_key(self) -> str:
        return self.CATALOG_EXPORT_API_KEY or self.CATALOG_EXPORT_KEY

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",") if o.strip()]


settings = Settings()
