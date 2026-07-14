-- AI Engine: собственная БД. Каталог основного проекта не дублируется,
-- сюда синхронизируется поисковая проекция товаров через Catalog Connector.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE products (
    id            BIGINT PRIMARY KEY,          -- id из основного проекта
    title         TEXT NOT NULL,
    brand         TEXT,
    category      TEXT,
    price         NUMERIC(12,2) NOT NULL,
    old_price     NUMERIC(12,2),
    in_stock      BOOLEAN NOT NULL DEFAULT true,
    stock_qty     INT DEFAULT 0,
    rating        REAL DEFAULT 0,
    popularity    REAL DEFAULT 0,
    margin        REAL DEFAULT 0,
    is_promo      BOOLEAN DEFAULT false,
    image_url     TEXT,
    specs         JSONB DEFAULT '{}'::jsonb,
    search_text   TEXT,
    embedding     vector(768),
    updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_products_fts   ON products USING gin (to_tsvector('russian', coalesce(search_text,'')));
CREATE INDEX idx_products_cat   ON products (category);
CREATE INDEX idx_products_price ON products (price);

CREATE TABLE knowledge_chunks (
    id         BIGSERIAL PRIMARY KEY,
    source     TEXT NOT NULL,                  -- faq | promo | delivery | warranty | news
    title      TEXT,
    content    TEXT NOT NULL,
    embedding  vector(768),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_memory (
    user_id          TEXT PRIMARY KEY,
    preferred_brands JSONB DEFAULT '[]'::jsonb,
    preferred_categories JSONB DEFAULT '[]'::jsonb,
    budget_min       NUMERIC(12,2),
    budget_max       NUMERIC(12,2),
    viewed_products  JSONB DEFAULT '[]'::jsonb,
    purchased        JSONB DEFAULT '[]'::jsonb,
    updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE chat_history (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content    TEXT NOT NULL,
    intent     TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_history_user ON chat_history (user_id, created_at DESC);

CREATE TABLE ai_analytics (
    id            BIGSERIAL PRIMARY KEY,
    trace_id      UUID UNIQUE,
    user_id       TEXT,
    question      TEXT,
    answer_text   TEXT,
    intent        TEXT,
    model         TEXT,
    provider      TEXT,
    latency_ms    INT,
    tokens_in     INT DEFAULT 0,
    tokens_out    INT DEFAULT 0,
    cost_usd      NUMERIC(10,6) DEFAULT 0,
    cache_hit     BOOLEAN DEFAULT false,
    product_ids   JSONB DEFAULT '[]'::jsonb,
    feedback      SMALLINT,
    converted     BOOLEAN DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_analytics_created ON ai_analytics (created_at DESC);
