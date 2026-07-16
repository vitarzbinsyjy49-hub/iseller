# AI Seller Demo MVP v3 — Ozon-style UI (fixed-critical)

**v3-fixed-critical:** устойчивость навигации — BottomNav переведён с NavLink на
Link + useLocation (исключает крэш hasValidRef/NavLinkWithRef при расхождении версий
react-router-dom), добавлен ErrorBoundary (вместо белого экрана — дружелюбный fallback),
зафиксированы package-lock.json для frontend/admin (главная защита от «у меня крашится»:
ставьте зависимости через `npm ci`), defensive rendering AI-ответов (undefined cards/meta
не роняют чат), LeadForm рендерится через React Portal в document.body (fixed строго от
viewport, шторка не «улетает» на прокрученной странице), live-поиск на Главной
(debounce 250ms, inline-подсказки, empty state) и debounce в Каталоге, поисковые алиасы
(ps5 → PlayStation, айфон → iPhone и т.п.), локальные SVG-placeholder'ы вместо
dummyimage.com (сид обновляет старые URL при повторном запуске), pb-40 на карточке
товара (CTA не перекрывает контент), preview-proxy в vite.config для проверки
production-сборки: `npm run build && npx vite preview` (бэкенд на localhost:8000).

**v3 (ozon-ui):** градиентный header на главной с точкой выдачи и поиском,
избранное (сердечки на карточках, localStorage), «Осталось N шт» и «В наличии · Сегодня»
на карточках, sticky-поиск в каталоге, карточка товара в стиле marketplace
(sticky top bar назад/поиск/поделиться/избранное, табы Описание / Характеристики / Получение,
CTA «Оставить заявку» с подписью «Менеджер свяжется сегодня»), секция «Рекомендуем»
сеткой 2 колонки, `stock` в карточке API, портируемый smoke-тест (Windows/Git Bash: JSON-тела
через файл, авто-выбор python/python3/jq).

**v2:** светлый UI в стиле Telegram × Яндекс Go/Лавка, motion-система, bottom sheet заявки
с выбором самовывоз/доставка, фильтры каталога («В наличии», «Забрать сегодня», бренд, цена),
AI-чат с bubbles и typing-индикатором, закреплённая CTA-зона в карточке товара,
расширенная админка (полное редактирование товара, JSON-импорт, источники заявок), 30 демо-товаров.

Демонстрационная версия Telegram Mini App-магазина техники с AI-подбором, каталогом, заявками (CRM) и админкой. Собрана на готовых артефактах (Sprint 1 + AI Engine + Integration Layer) и доведена до состояния демо для показа заказчику.

## Что показывает демо

Пользователь открывает Mini App → видит каталог техники → задаёт AI-запрос («Подбери ноутбук до 150 тысяч для монтажа») → получает ответ и карточки товаров → оставляет заявку → заявка появляется в админке → события видны в аналитике.

**Демо работает без каких-либо ключей и без Ollama** — по умолчанию `AI_PROVIDER=fallback`, ответы формируются по каталогу. Реальный AI (Ollama/OpenAI) подключается опционально.


## Важная правка hotfix

В этом архиве AI stack вынесен в Docker profile `ai`. Обычный запуск поднимает только основной демо-цикл: backend + frontend + admin + PostgreSQL, а AI работает через `AI_PROVIDER=fallback`.

Обычный демо-запуск:
```bash
docker compose -f docker-compose.demo.yml up -d --build
```

Если позже нужен реальный AI Engine/Ollama:
```bash
docker compose -f docker-compose.demo.yml --profile ai up -d --build
docker compose -f docker-compose.demo.yml --profile ai exec ollama ollama pull qwen2.5:7b-instruct
```

## Быстрый старт (локально, 3 команды)

```bash
cp .env.example .env          # уже готов к запуску, менять не обязательно
docker compose -f docker-compose.demo.yml up -d --build
docker compose -f docker-compose.demo.yml exec backend python -m app.scripts.seed_products
```

Откройте:
- **Mini App:** http://localhost:5173
- **Админка:** http://localhost:5174 (email `admin@techshop.local`, пароль `admin12345`)
- **API-доки:** http://localhost:8000/api/docs

## Шаги для запуска в реальном Telegram

1. Создайте бота в **@BotFather** → получите `TELEGRAM_BOT_TOKEN`.
2. Впишите токен и `BOT_USERNAME` в `.env`.
3. Через BotFather задайте Web App URL (`MINI_APP_URL`) — публичный HTTPS-адрес фронтенда.
4. `docker compose -f docker-compose.demo.yml up -d --build`.
5. Откройте фронтенд/админку в браузере — проверьте dev-режим.
6. Проверьте AI в режиме fallback (по умолчанию).
7. (Опционально) включите Ollama: `AI_PROVIDER=ai` + `docker compose --profile ai up -d` + загрузка модели.
8. Откройте Mini App в Telegram по кнопке бота.

Подробности — в `docs/BOTFATHER_SETUP.md` и `docs/ENV_SETUP.md`.

## Три режима AI

| `AI_PROVIDER` | Что делает | Нужны ключи/Ollama |
|---|---|---|
| `fallback` (по умолчанию) | Умный подбор по каталогу без LLM | Нет |
| `mock` | То же, что fallback | Нет |
| `ai` | Использует AI Engine (Ollama/OpenAI), при сбое — fallback | Да |

Во всех режимах цены и наличие берутся только из БД, не из модели.

## Структура

```
backend/       FastAPI: auth, каталог, заявки (CRM), аналитика, AI-шлюз
frontend/      React Mini App: Home, AI, Каталог, Товар, Заявки, Профиль
admin/         React админка: Дашборд, Заявки, Товары, Аналитика, AI-логи
ai-engine/     Отдельный AI-сервис (Ollama/Meilisearch/Redis) — опционален
docs/          Документация
docker-compose.demo.yml
.env.example
scripts/smoke_test_demo.sh
```

## Проверка (smoke-test)

```bash
docker compose -f docker-compose.demo.yml exec backend true   # убедиться, что стек поднят
BASE_URL=http://localhost:8000 ./scripts/smoke_test_demo.sh
```

Скрипт проверяет весь сценарий: health → dev login → каталог → детали товара → AI chat → заявка → админка → аналитика → экспорт каталога.

## Документы

- `docs/ARCHITECTURE.md` — как устроен проект и потоки данных
- `docs/ENV_SETUP.md` — все переменные окружения
- `docs/BOTFATHER_SETUP.md` — настройка Telegram-бота
- `docs/SMOKE_TEST.md` — как прогнать проверки
- `docs/KNOWN_LIMITATIONS.md` — что упрощено для демо
