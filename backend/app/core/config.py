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
    # ai            — сначала пробовать AI Engine, при ошибке — тот же fallback.
    # Демо по умолчанию = fallback, чтобы не зависеть от Ollama/ключей.
    AI_PROVIDER: str = "fallback"

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
