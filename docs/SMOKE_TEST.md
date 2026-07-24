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

## v5.4.0: сценарные заявки и галерея

16. `POST /api/leads` c `lead_type=trade_in` + `metadata` → 201, ответ содержит `lead_type`/`metadata`; неизвестный `lead_type` → `general`; не-object metadata → 422.
17. `GET /api/admin/leads?type_filter=trade_in` — фильтр по типу заявки работает.
18. `GET /api/catalog/feed` — карточки содержат ключ `images` (эффективная галерея).
19. Галерея: `POST …/images` при 10 фото → 400; `…/images/bulk` уважает остаток слотов; `…/images/main` ставит URL в индекс 0; `…/images/reorder` отклоняет чужой/дублирующий набор; ZIP >10 → `excess_images` в отчёте.
20. `GET /api/admin/photo-coverage` — сводка покрытия (read-only, без внешних URL-проверок).
21. UI (на устройстве): 6 кнопок Home (iPhone/аксессуары → каталог; MacBook → меню AI; Trade-In/бизнес/опт → bottom-sheet, НЕ внешний менеджер); отправка заявки → «Посмотреть заявку»; карусель фото на карточках (свайп vs тап, точки, без h-overflow); мультизагрузка/порядок в админке; safe-area Telegram сверху/снизу.
22. Скрипт: `DATABASE_URL=… python scripts/photo_coverage_audit.py` → `summary.md`/`coverage.csv`/`coverage.json`.
