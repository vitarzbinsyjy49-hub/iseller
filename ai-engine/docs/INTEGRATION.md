# Интеграция AI Engine с существующим проектом

Внутренняя архитектура вашего проекта **не меняется**. Нужны 4 точки подключения.

## 1. Каталог → AI Engine (единственное требование к вашему бэкенду)
Отдайте товары по HTTP (URL в `CATALOG_API_URL`). Формат ответа — JSON-массив:
```json
[{"id": 1, "title": "MacBook Pro 14", "brand": "Apple", "category": "ноутбуки",
  "price": 149000, "old_price": 169000, "in_stock": true, "rating": 4.9,
  "popularity": 90, "margin_pct": 12.5, "is_new": false, "on_sale": true,
  "specs": {"cpu": "M4", "ram": "16 ГБ"}, "image": "https://...", "url": "https://..."}]
```
Поддерживается `?updated_since=ISO8601` для инкрементальной синхронизации.
Запуск синхронизации: `POST /api/v1/admin/sync-catalog` (повесьте на cron каждые 5–15 мин
или дергайте вебхуком при изменении товара).

Если формат вашего API другой — правится ОДИН файл: `app/connectors/http_impl.py`.

## 2. Mini App → AI Engine
Фронтенд Mini App вызывает (через ваш бэкенд-прокси, чтобы не светить X-API-Key):
| Метод | Эндпоинт | Назначение |
|---|---|---|
| POST | /api/v1/chat | свободный вопрос → текст + карточки + кнопки |
| POST | /api/v1/recommend | подбор по параметрам |
| POST | /api/v1/compare | сравнение по product_ids |
| POST | /api/v1/search | поиск без LLM (быстро/бесплатно) |
| GET  | /api/v1/history/{user_id} | история диалога |
| POST | /api/v1/feedback | оценка ответа 1–5 |

`user_id` = Telegram user id из initData (валидируйте initData на вашем бэкенде).
Кнопки в карточках (`open_product`, `add_to_cart`, `notify_stock`, `compare`, `refine`) —
это события для ВАШЕГО фронтенда: AI Engine не знает, как устроена ваша корзина.

## 3. События покупок → AI Engine (конверсия)
После оформления заказа ваш бэкенд шлёт:
```
POST /api/v1/events/purchase
{"user_id": "42", "analytics_id": 17, "product_ids": [1]}
```
`analytics_id` приходит в `meta` каждого ответа — прокиньте его до checkout.

## 4. Админка → AI Engine
Раздел «AI» в вашей админке = один запрос:
```
GET /api/v1/admin/dashboard?days=7
→ {"requests": ..., "avg_latency_ms": ..., "total_cost_usd": ..., "cache_hits": ...,
   "errors": ..., "conversions": ..., "avg_rating": ..., "top_questions": [...]}
```

## Смена модели без кода
```
LLM_PROVIDER=anthropic  LLM_MODEL=claude-sonnet-4-6      LLM_API_KEY=sk-...
LLM_PROVIDER=openai     LLM_MODEL=gpt-4o-mini            LLM_API_KEY=sk-...
LLM_PROVIDER=deepseek   LLM_MODEL=deepseek-chat  LLM_BASE_URL=https://api.deepseek.com
LLM_PROVIDER=gemini     LLM_MODEL=gemini-2.0-flash
LLM_PROVIDER=ollama     LLM_MODEL=qwen2.5:7b-instruct  # или gemma3, deepseek-r1 и т.д.
```

## Чек-лист внедрения
1. `cp .env.example .env`, задать `AI_ENGINE_API_KEY` и `CATALOG_API_URL`.
2. `docker compose up -d --build`, `ollama pull <модель>`.
3. `POST /admin/sync-catalog` — проверить `{"synced": N}`.
4. Проксировать /chat из Mini App, отрисовать `cards[]` и `actions[]`.
5. Повесить cron на sync-catalog и вебхук на /events/purchase.
6. (Позже) переключить LLM_PROVIDER, поменять веса в config/settings.yaml — без деплоя кода.
