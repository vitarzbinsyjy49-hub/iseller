#!/usr/bin/env bash
# Однокомандный деплой патча на сервере.
# Использование (на VPS, из корня проекта):  bash deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo ">> git pull"
git pull --ff-only

echo ">> rebuild & restart"
docker compose -f docker-compose.prod.yml up -d --build

echo ">> prune old images"
docker image prune -f >/dev/null 2>&1 || true

echo ">> done. Статус:"
docker compose -f docker-compose.prod.yml ps
