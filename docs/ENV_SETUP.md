# Настройка окружения (ENV_SETUP)

Все переменные основного backend — в `.env` (шаблон `.env.example`). Демо запускается со значениями по умолчанию: скопируйте `.env.example` в `.env` и всё.

## Переменные основного backend

| Переменная | Обязательна | Демо-значение | Назначение |
|---|---|---|---|
| `POSTGRES_USER/PASSWORD/DB` | да | techshop | Учётные данные Postgres (совпадают с compose) |
| `DATABASE_URL` | да | postgresql+psycopg://techshop:techshop@db:5432/techshop | Строка подключения к БД |
| `DEV_MODE` | да | true | true — вход без Telegram (/auth/dev). На проде false |
| `JWT_SECRET` | да | change-me… | Секрет подписи JWT. **Заменить на проде** |
| `ADMIN_EMAIL` | да | admin@techshop.local | Логин админки |
| `ADMIN_PASSWORD` | да | admin12345 | Пароль админки. **Заменить на проде** |
| `TELEGRAM_BOT_TOKEN` | для Telegram | (пусто) | Токен бота из BotFather |
| `BOT_USERNAME` | для Telegram | (пусто) | @username бота |
| `MINI_APP_URL` / `WEBAPP_URL` | для Telegram | (пусто) | Публичный HTTPS-адрес Mini App |
| `ALLOWED_ORIGINS` | на проде | (пусто) | Список доменов для CORS (через запятую) |
| `AI_PROVIDER` | да | fallback | fallback \| mock \| ai |
| `AI_ENGINE_URL` | при ai | http://ai-engine:8090 | Адрес AI Engine |
| `AI_ENGINE_API_KEY` | при ai | change-me | Общий секрет backend↔AI Engine |
| `AI_ENGINE_TIMEOUT_SECONDS` | нет | 20 | Таймаут запроса к AI Engine |
| `CATALOG_EXPORT_API_KEY` | при ai | change-me-catalog-key | Ключ, которым AI Engine забирает каталог |
| `AI_CHAT_RATE_LIMIT_PER_MINUTE` | нет | 10 | Лимит AI-запросов на пользователя в минуту |
| `RATE_LIMIT_REDIS_URL` | нет | (пусто) | Redis для распределённого лимита; пусто = in-memory |
| `MEILISEARCH_KEY` | нет | masterKey | Мастер-ключ Meilisearch (для AI Engine) |

## Переменные AI Engine (`ai-engine/.env`)

Нужны только при `AI_PROVIDER=ai`. Главное: `DATABASE_URL` с async-драйвером (`postgresql+asyncpg://…`), `CATALOG_API_URL=http://backend:8000/api/catalog/export`, `CATALOG_API_KEY` = `CATALOG_EXPORT_API_KEY` основного backend, выбор LLM через `LLM_PROVIDER` (`ollama`|`openai`|`anthropic`|`gemini`). Полный список — в `ai-engine/.env.example`.

## Что заменить перед продакшеном

`DEV_MODE=false`, длинный случайный `JWT_SECRET`, сильный `ADMIN_PASSWORD`, реальный `ALLOWED_ORIGINS`, все ключи (`AI_ENGINE_API_KEY`, `CATALOG_EXPORT_API_KEY`, `MEILISEARCH_KEY`) — на случайные. AI Engine, Ollama, Meilisearch наружу не публиковать.

## Соответствие ключей backend ↔ AI Engine

- `AI_ENGINE_API_KEY` (backend) == `AI_ENGINE_API_KEY` (ai-engine)
- `CATALOG_EXPORT_API_KEY` (backend) == `CATALOG_API_KEY` (ai-engine)

Если пары не совпадают — AI Engine не сможет забрать каталог, а backend получит 401 от движка (и уйдёт в fallback).
