# Настройка Telegram-бота (BotFather)

Демо работает и в браузере (dev-режим), но для показа «как в Telegram» нужен бот.

## Шаги

1. Откройте **@BotFather** в Telegram → `/newbot` → задайте имя и username. Получите **токен** вида `123456:ABC-...`.
2. Впишите в `.env`:
   ```
   TELEGRAM_BOT_TOKEN=<ваш токен>
   BOT_USERNAME=<username_бота>
   ```
3. Разместите фронтенд на публичном **HTTPS** (Telegram Mini App требует HTTPS). Для локальной проверки подойдёт туннель (ngrok/cloudflared) на порт 5173.
4. Впишите публичный адрес:
   ```
   MINI_APP_URL=https://<ваш-домен>
   WEBAPP_URL=https://<ваш-домен>
   ```
5. В BotFather привяжите Web App:
   - `/newapp` (или `/myapps`) → выберите бота → укажите URL из `MINI_APP_URL`;
   - либо `/setmenubutton` → задайте кнопку меню, ведущую на Web App.
6. Перезапустите backend, чтобы токен подхватился:
   ```
   docker compose -f docker-compose.demo.yml up -d
   ```
7. Откройте бота в Telegram, нажмите кнопку меню/Web App — откроется Mini App.

## Проверка подписи

Backend уже умеет проверять подпись Telegram (`initData`) — эта логика из Sprint 1 не менялась. Когда Mini App открыт внутри Telegram, фронтенд шлёт `initData` на `/api/auth/telegram`; вне Telegram используется `/api/auth/dev`.

## Частые проблемы

- **Mini App не открывается** — URL должен быть HTTPS и доступен извне; проверьте туннель.
- **Ошибка входа в Telegram** — проверьте, что `TELEGRAM_BOT_TOKEN` в `.env` совпадает с токеном бота, чей Web App вы открываете.
- **Работает в браузере, но не в Telegram** — это нормально для dev-режима; для Telegram нужен корректный `initData`, то есть открытие именно через кнопку бота.

## Какие ключи вставить владельцу (сводка)

Обязательно для Telegram: `TELEGRAM_BOT_TOKEN`, `BOT_USERNAME`, `MINI_APP_URL`, `WEBAPP_URL`.
Обязательно всегда: `JWT_SECRET`, `ADMIN_PASSWORD`, `DATABASE_URL`.
Только при `AI_PROVIDER=ai`: `AI_ENGINE_URL`, `AI_ENGINE_API_KEY`, `CATALOG_EXPORT_API_KEY`, и (по выбору) `OPENAI_API_KEY` или `OLLAMA_BASE_URL`.
