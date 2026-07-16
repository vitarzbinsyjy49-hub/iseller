#!/usr/bin/env bash
# Обновление сервера в одну команду.
# Синхронизирует локальный код на VPS и пересобирает стек (бот + админка).
# Запуск из Git Bash в папке проекта:  bash update-server.sh
#
# .env на сервере НЕ трогается (исключён из синхронизации) — секреты и токен сохраняются.
set -euo pipefail

SERVER="iseller"                 # алиас из ~/.ssh/config -> root@158.255.1.248
REMOTE_DIR="/opt/techshop"

echo ">> синхронизирую код на сервер ($SERVER:$REMOTE_DIR)"
tar czf - \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.env \
  --exclude=.git \
  --exclude=caddy_data \
  --exclude=caddy_config \
  --exclude=update-server.sh \
  . | ssh "$SERVER" "mkdir -p $REMOTE_DIR && tar xzf - -C $REMOTE_DIR"

echo ">> пересобираю и перезапускаю стек"
ssh "$SERVER" "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml up -d --build && docker image prune -f >/dev/null 2>&1 || true"

echo ">> статус:"
ssh "$SERVER" "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml ps --format 'table {{.Service}}\t{{.Status}}'"

echo ">> готово. Бот и админка обновлены."
