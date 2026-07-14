# Архитектура TechShop Demo MVP

## Общая схема

```
Telegram Mini App (React)
        │  все запросы через /api (JWT)
        ▼
Основной backend (FastAPI + PostgreSQL)
   ├─ auth (Telegram/dev + JWT)
   ├─ catalog (товары, категории, фильтры, детали, export)
   ├─ leads (CRM: заявки)
   ├─ analytics (события воронки)
   └─ AI Gateway  ──POST /api/v1/chat (X-API-Key)──►  AI Engine (опционально)
        │                                              ├─ Ollama / OpenAI
        └─ fallback: build_demo_answer по каталогу     ├─ Meilisearch
                                                        └─ Redis / своя PG
Admin panel (React) ── /api (admin JWT) ──► backend
```

## Ключевой принцип: демо не ломается

AI-запрос из Mini App всегда идёт в backend `POST /api/ai/chat`. Дальше:

- `AI_PROVIDER=fallback|mock` — backend отвечает сам, подбирая товары из каталога правилами (бюджет + категория). Быстро, без ключей.
- `AI_PROVIDER=ai` — backend зовёт AI Engine; если тот недоступен/медленный/сломан — ловится исключение и включается тот же fallback.

В любом случае пользователь получает `200 OK` с текстом и карточками. `meta.source` показывает, что сработало: `ai` / `fallback` / `cache`.

## Потоки данных

**Каталог → AI Engine.** AI Engine периодически (или по кнопке) забирает каталог через `GET /api/catalog/export` (server-to-server, `X-API-Key`). Так модель видит актуальные товары, но получает их из БД, а не выдумывает.

**Mini App → аналитика.** Фронтенд шлёт UI-события (`app_opened`, `product_viewed`, `ai_product_card_clicked` и т.д.) в `POST /api/events`. Серверные события AI-воронки (`ai_query_submitted`, `ai_response_received`, `lead_created`) пишет сам backend — им нельзя доверять клиенту.

**Заявка.** `POST /api/leads` (JWT) создаёт `Lead`, подставляя `telegram_id`/`username` из проверенного профиля и `product_title` из БД. Админка читает заявки через `GET /api/admin/leads` и меняет статус через `PATCH`.

## Слои backend

| Модуль | Ответственность |
|---|---|
| `api/auth.py` | Telegram-auth, dev-login, admin-login, refresh (из Sprint 1, не менялся) |
| `api/catalog.py` | export (для AI), search (fallback), list/categories/brands/feed/product |
| `api/ai.py` | AI-шлюз: rate limit → provider → fallback → события |
| `api/leads.py` | создание и просмотр своих заявок |
| `api/admin_crm.py` | заявки, дашборд, аналитика, AI-логи, управление товарами |
| `api/events.py` | приём UI-событий (whitelist) |
| `services/ai_client.py` | единственная точка HTTP-общения с AI Engine |
| `services/ai_provider.py` | demo/fallback-ответ по каталогу (без LLM) |
| `core/rate_limit.py` | лимит на AI-чат (in-memory + опц. Redis) |

## Экраны Mini App

Home (категории, баннер, горячее/сегодня/рекомендуем) · AI Search (быстрые кнопки, ответ, карточки, заявка/менеджер) · Catalog (категории, поиск, фильтры, сортировка) · Product Details (фото, цена, наличие, гарантия, характеристики, 4 действия) · Requests (мои заявки со статусами) · Profile (Telegram-данные, счётчик заявок, источник входа).

## Админка

Dashboard (метрики + популярные товары + последние события) · Leads (фильтр по статусу, смена статуса, комментарий) · Products (цена/склад/активность/хит) · Analytics (воронка + источники + события) · AI Logs (запрос, источник, карточки, задержка).

## Инварианты безопасности

Mini App не ходит в AI Engine напрямую — только через backend, который держит ключи у себя. `user_id` для AI Engine формируется из проверенного JWT. Цены/наличие — только из БД. В LLM уходит не более 12 товаров. Экспорт каталога закрыт отдельным ключом. Rate limit, ограничение длины запроса и timeout — на AI-шлюзе. Весь SQL — через SQLAlchemy ORM, без сырых запросов от пользователя. На фронтенде нет `dangerouslySetInnerHTML`.

## Базы данных

Основной backend — своя PostgreSQL (`users`, `products`, `leads`, `analytics_events`, `audit_logs`). AI Engine — своя PostgreSQL (pgvector, синхронизированная копия каталога + история/аналитика движка). Связь только по HTTP-контракту, без общей схемы.
