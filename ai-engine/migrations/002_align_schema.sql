-- 002: приведение схемы к фактическому коду AI Engine.
-- В 001 колонки назывались иначе, чем в коде (margin vs margin_pct, answer_text vs answer,
-- image_url vs image и т.д.), а таблиц answer_cache и ai_feedback не было вовсе —
-- любой запрос падал бы. Миграция идемпотентна (IF NOT EXISTS), запускать безопасно.

-- products: колонки, которые пишет catalog_sync и читает recommender/response_builder
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS margin_pct REAL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_new     BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS on_sale    BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS image      TEXT,
    ADD COLUMN IF NOT EXISTS url        TEXT;

-- chat_history: memory.remember_interaction пишет product_ids
ALTER TABLE chat_history
    ADD COLUMN IF NOT EXISTS product_ids JSONB DEFAULT '[]'::jsonb;

-- user_memory: recommender и memory.update_preferences используют favorite_*
ALTER TABLE user_memory
    ADD COLUMN IF NOT EXISTS favorite_brands     JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS favorite_categories JSONB DEFAULT '[]'::jsonb;

-- ai_analytics: analytics.logger пишет в эти колонки
ALTER TABLE ai_analytics
    ADD COLUMN IF NOT EXISTS answer            TEXT,
    ADD COLUMN IF NOT EXISTS prompt_tokens     INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS completion_tokens INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS error             TEXT;

-- Оценки ответов (routes.feedback -> analytics.feedback)
CREATE TABLE IF NOT EXISTS ai_feedback (
    id           BIGSERIAL PRIMARY KEY,
    analytics_id BIGINT,
    user_id      TEXT,
    rating       SMALLINT CHECK (rating BETWEEN 1 AND 5),
    comment      TEXT DEFAULT '',
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- Тёплый слой кэша (core/cache.py), переживающий рестарт Redis
CREATE TABLE IF NOT EXISTS answer_cache (
    key        TEXT PRIMARY KEY,
    payload    JSONB NOT NULL,
    hits       INT DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_cache_expires ON answer_cache (expires_at);
