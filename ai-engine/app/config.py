"""Централизованная конфигурация. Провайдер LLM, поиск и веса ранжирования
меняются через .env и config/settings.yaml — без изменения кода.

FIX (integration): добавлены настройки и функции, на которые ссылался код,
но которых не существовало (падение при старте):
- Settings: crm_api_url, catalog_api_key, llm_max_tokens, max_products_to_llm,
  semantic_cache_enabled, cache_ttl_seconds + алиасы meili_url/meili_key;
- get_business_config() и get_prompts(), которые импортировали pipeline,
  recommender и prompt_builder.
"""
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic_settings import BaseSettings

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    ai_engine_env: str = "development"
    ai_engine_api_key: str = "dev-key"

    database_url: str = "postgresql+asyncpg://ai:ai@localhost:5433/ai_engine"
    redis_url: str = "redis://localhost:6380/0"

    search_backend: str = "postgres"          # meilisearch | postgres | pgvector
    meilisearch_url: str = "http://localhost:7700"
    meilisearch_key: str = "masterKey"

    llm_provider: str = "ollama"              # ollama | openai | anthropic | gemini
    llm_model: str = "qwen2.5:7b-instruct"
    llm_max_tokens: int = 600
    ollama_url: str = "http://localhost:11434"
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    gemini_api_key: str = ""

    max_products_to_llm: int = 12             # полный каталог в модель не уходит никогда
    semantic_cache_enabled: bool = True
    cache_ttl_seconds: int = 3600

    catalog_api_url: str = ""
    catalog_api_key: str = ""                 # X-API-Key к /api/catalog/export основного проекта
    crm_api_url: str = ""
    analytics_webhook_url: str = ""

    # Алиасы: retriever и catalog_sync исторически обращаются к коротким именам
    @property
    def meili_url(self) -> str:
        return self.meilisearch_url

    @property
    def meili_key(self) -> str:
        return self.meilisearch_key

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_yaml_config() -> dict:
    with open(BASE_DIR / "config" / "settings.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def get_business_config() -> dict:
    """Бизнес-настройки (ranking, faq, intents) из config/settings.yaml."""
    return get_yaml_config()


@lru_cache
def get_prompts() -> dict:
    """Промпты для генерации ответа из config/prompts/system.yaml."""
    with open(BASE_DIR / "config" / "prompts" / "system.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)
