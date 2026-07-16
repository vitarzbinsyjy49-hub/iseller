# Деплой AI Seller на VPS (production)

Пошаговая инструкция, как поднять Mini App на сервере с настоящим HTTPS
и открыть его в Telegram. Всё держится на Docker Compose + Caddy (авто-HTTPS).

## Что понадобится
- VPS (РФ), Ubuntu 24.04, 2 ГБ RAM, доступ по SSH (root).
- Токен и username бота из [@BotFather](https://t.me/BotFather).
- Два бесплатных поддомена [DuckDNS](https://www.duckdns.org), указывающие на IP сервера.

---

## 1. DNS (DuckDNS)
1. Зайти на duckdns.org (можно через GitHub) → создать два поддомена, например
   `techshop-demo` и `techshop-admin`.
2. В поле **current ip** для обоих указать IP сервера (или обновить токеном).
3. Проверка: `ping techshop-demo.duckdns.org` должен вести на IP сервера.

## 2. Подготовка сервера
```bash
# под root на свежем Ubuntu 24.04
apt update && apt -y upgrade
curl -fsSL https://get.docker.com | sh          # Docker + compose-plugin
# 2 ГБ swap — чтобы npm build не упал по памяти на 2 ГБ VPS:
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 3. Забрать код
```bash
git clone https://github.com/<ТВОЙ_ЛОГИН>/techshop.git
cd techshop
cp .env.prod.example .env
nano .env      # заполнить домены, пароли, TELEGRAM_BOT_TOKEN, JWT_SECRET
```

Обязательно поменять в `.env`:
- `DOMAIN`, `ADMIN_DOMAIN` — твои поддомены DuckDNS;
- `POSTGRES_PASSWORD` и тот же пароль внутри `DATABASE_URL`;
- `JWT_SECRET` — длинная случайная строка;
- `ADMIN_PASSWORD`;
- `TELEGRAM_BOT_TOKEN`, `BOT_USERNAME`;
- `MINI_APP_URL`, `WEBAPP_URL`, `ALLOWED_ORIGINS` — под свой `DOMAIN`.

## 4. Первый запуск
```bash
bash deploy/first_run.sh
```
Скрипт соберёт образы, поднимет стек и наполнит БД товарами.
Caddy сам получит HTTPS-сертификаты (нужно, чтобы домены уже вели на сервер и порты 80/443 были открыты).

Проверка:
- `https://techshop-demo.duckdns.org` — Mini App;
- `https://techshop-admin.duckdns.org` — админка (email/пароль из `.env`).

## 5. Привязать Web App в BotFather
1. [@BotFather](https://t.me/BotFather) → `/mybots` → выбрать бота → **Bot Settings → Menu Button** →
   указать URL `https://techshop-demo.duckdns.org`.
   (Или `/newapp` → выбрать бота → указать тот же URL.)
2. Открыть бота в Telegram → нажать кнопку меню → откроется Mini App.

---

## Как выкатывать патчи потом
Локально: правим код → `git push`.
На сервере:
```bash
cd techshop && bash deploy/deploy.sh
```
Один вызов: `git pull` + пересборка изменённых образов + рестарт.

## Диагностика
```bash
docker compose -f docker-compose.prod.yml ps          # статус сервисов
docker compose -f docker-compose.prod.yml logs -f caddy    # выдача сертификата
docker compose -f docker-compose.prod.yml logs -f backend
```
- **HTTPS не выдаётся** — проверь, что DuckDNS-домены ведут на этот сервер и порты 80/443 не закрыты фаерволом/провайдером.
- **Mini App не открывается в Telegram** — URL в BotFather должен быть строго `https://` и совпадать с `DOMAIN`.
- **502 на /api** — backend ещё поднимается или упал; смотри его логи.
