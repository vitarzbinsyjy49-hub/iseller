#!/usr/bin/env bash
# Обновление сервера в одну команду (с деплой-страховкой, v4 pre-launch).
# Запуск из Git Bash в папке проекта:  bash update-server.sh
#
# Что делает:
#   1) pg_dump боевой БД -> /opt/backups/techshop_YYYY-mm-dd_HHMM.sql.gz на сервере;
#   2) tar-синхронизация кода (серверный .env НЕ трогается);
#   3) пересборка и перезапуск стека;
#   4) health check /api/health — если он не прошёл, скрипт завершается ошибкой
#      (код и контейнеры уже обновлены; откат = git checkout + повторный запуск,
#       данные целы — бэкап из шага 1).
set -euo pipefail

SERVER="iseller"                 # алиас из ~/.ssh/config -> root@158.255.1.248
REMOTE_DIR="/opt/techshop"
BACKUP_DIR="/opt/backups"
# backend порт наружу не пробрасывает (см. docker-compose.prod.yml) — проверяем
# изнутри docker-сети через `compose exec`, а не localhost:8000 на хосте.
HEALTH_CMD="docker compose -f docker-compose.prod.yml exec -T backend python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=3)\""

echo ">> 1/4 бэкап боевой БД (pg_dump -> $BACKUP_DIR)"
ssh "$SERVER" "set -e; mkdir -p $BACKUP_DIR; cd $REMOTE_DIR && \
  docker compose -f docker-compose.prod.yml exec -T db sh -c 'pg_dump -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"' \
  | gzip > $BACKUP_DIR/techshop_\$(date +%F_%H%M).sql.gz && \
  ls -lh $BACKUP_DIR | tail -3"

echo ">> 2/4 синхронизирую код на сервер ($SERVER:$REMOTE_DIR)"
tar czf - \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.env \
  --exclude=.git \
  --exclude=caddy_data \
  --exclude=caddy_config \
  --exclude=update-server.sh \
  . | ssh "$SERVER" "mkdir -p $REMOTE_DIR && tar xzf - -C $REMOTE_DIR"

echo ">> 3/4 пересобираю и перезапускаю стек"
ssh "$SERVER" "set -e; cd $REMOTE_DIR; docker compose -f docker-compose.prod.yml up -d --build; docker image prune -f >/dev/null 2>&1 || true"

echo ">> 4/4 health check (внутри docker-сети, до 60 секунд)"
if ssh "$SERVER" "cd $REMOTE_DIR && for i in \$(seq 1 12); do $HEALTH_CMD >/dev/null 2>&1 && exit 0; sleep 5; done; exit 1"; then
  echo ">> health OK"
else
  echo "!! HEALTH CHECK FAILED — backend не отвечает на /api/health изнутри контейнера"
  echo "!! Смотрите логи: ssh $SERVER 'cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml logs backend --tail 50'"
  ssh "$SERVER" "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml ps --format 'table {{.Service}}\t{{.Status}}'" || true
  exit 1
fi

echo ">> статус контейнеров:"
ssh "$SERVER" "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml ps --format 'table {{.Service}}\t{{.Status}}'"

echo ">> готово. Бот и админка обновлены, бэкап БД лежит в $BACKUP_DIR."
