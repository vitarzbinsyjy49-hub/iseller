# Smoke-test

Проверяет, что ключевой демо-сценарий работает целиком.

## Запуск

```bash
docker compose -f docker-compose.demo.yml up -d --build
docker compose -f docker-compose.demo.yml exec backend python -m app.scripts.seed_products

BASE_URL=http://localhost:8000 \
ADMIN_EMAIL=admin@techshop.local ADMIN_PASSWORD=admin12345 \
CATALOG_EXPORT_API_KEY=change-me-catalog-key \
./scripts/smoke_test_demo.sh
```

Скрипт не требует `jq` (есть fallback на python3) и печатает `PASS/FAIL` по каждому шагу.

## Что проверяется

1. `GET /api/health` — backend жив, БД доступна.
2. `POST /api/auth/dev` — dev-вход (DEV_MODE=true).
3. `GET /api/catalog/list` — каталог отдаёт товары (seed выполнен).
4. `GET /api/catalog/product/{id}` — детали товара.
5. `POST /api/ai/chat` — AI отвечает в fallback/mock без ключей, есть `meta.source`.
6. `POST /api/leads` — заявка создаётся (с `delivery_method`).
7. `GET /api/leads/my` — заявка видна в «Мои заявки».
8. `POST /api/auth/admin/login` + `GET /api/admin/leads` — заявка видна в админке.
9. `PATCH /api/admin/leads/{id}` — смена статуса + комментарий менеджера.
10. `PATCH /api/admin/products/{id}` — обновление товара (is_hot).
11. `PATCH /api/admin/products/{id}/stock` — обновление наличия.
12. `POST /api/admin/products/import` — JSON-импорт (created/updated).
13. `GET /api/admin/dashboard` — дашборд отвечает.
14. `POST /api/events` — событие аналитики принимается.
15. `GET /api/catalog/export` — без ключа 401/503, с ключом 200.
