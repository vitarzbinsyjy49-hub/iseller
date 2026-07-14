#!/usr/bin/env bash
# Первый запуск на чистом сервере: поднять стек и наполнить БД товарами.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "!! Нет .env. Скопируй: cp .env.prod.example .env  и заполни значения."
  exit 1
fi

echo ">> build & up"
docker compose -f docker-compose.prod.yml up -d --build

echo ">> ждём готовности backend..."
sleep 8

echo ">> сидируем каталог товаров"
docker compose -f docker-compose.prod.yml exec -T backend python -m app.scripts.seed_products

echo ">> готово. Статус:"
docker compose -f docker-compose.prod.yml ps
