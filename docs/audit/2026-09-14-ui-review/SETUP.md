# Как поднять iseller-demo на macOS

Цель — увидеть все три поверхности живьём. Реальные ключи для этого не нужны
и вводить их никуда не надо: демо работает на значениях по умолчанию.

## 1. Что поставить

- **Git**, **Node 20+**, **Docker Desktop** (нужен: бэкенд и Postgres живут в нём).
- Проверка: `git --version && node -v && docker version`.

## 2. Клонировать

```bash
git clone https://github.com/vitarzbinsyjy49-hub/iseller.git iseller-demo
cd iseller-demo
```

Ветка по умолчанию — `master`, работа идёт прямо в ней. На момент выгрузки
актуальный коммит `680b0db`.

## 3. Завести .env

`.env` в репозиторий не попадает (он в `.gitignore`), поэтому его надо создать
из примера:

```bash
cp .env.example .env
```

**Значения из примера менять не нужно.** `AI_PROVIDER=fallback` — подбор
работает без ключей и без Ollama. Токен бота, ключи Anthropic и прочее для
визуального аудита не требуются: бот и канал в локальном стенде не поднимаются.
Если чего-то не хватит — скажите, что именно, но не вставляйте секреты в
переписку.

## 4. Поднять стек

```bash
docker compose -f docker-compose.demo.yml up -d --build
```

Первая сборка — несколько минут. Порты: **фронт 5173**, **админка 5174**,
**бэкенд 8000**.

## 5. Налить товары

Пустой каталог — это пустые экраны, аудировать нечего:

```bash
docker compose -f docker-compose.demo.yml exec backend python -m app.scripts.seed_products
```

## 6. Куда смотреть

| поверхность | адрес | как смотреть |
|---|---|---|
| Mini App, мобильный | http://localhost:5173 | окно 375×812, эмуляция устройства |
| Mini App, десктоп | http://localhost:5173 | окно от 1440px — включается другая раскладка |
| Админка | http://localhost:5174 | вход из `ADMIN_EMAIL` / `ADMIN_PASSWORD` в `.env` |

Приложение работает и вне Telegram: SDK не найден — берётся дев-режим.
Отличия от настоящего клиента перечислены в `BRIEF.md`, раздел «Чего вы не
увидите на стенде».

## 7. Если что-то не поднялось

```bash
docker compose -f docker-compose.demo.yml logs --tail=50 backend
docker compose -f docker-compose.demo.yml ps
```

Правки фронта Vite подхватывает не всегда (inotify через bind-mount):
`docker compose -f docker-compose.demo.yml restart frontend`. Изменения в
`tailwind.config.js` и `package.json` требуют `up -d --build frontend`.
