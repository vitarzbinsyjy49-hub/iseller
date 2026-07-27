# Backup-состояние перед восстановлением обработки команд бота
снято: 2026-07-28_0122

## git
базовый коммит master: 7d127670d761899dcd445df1c76066697289e179
рабочее дерево на момент снятия (незакоммиченные UI-правки прошлой задачи):
 M admin/src/Products.tsx
 M backend/app/api/admin_crm.py
 M backend/app/main.py
 M backend/app/models/product.py
 M backend/app/schemas/ai.py
 M backend/tests/test_products_admin.py
 M frontend/src/components/Layout.tsx
 M frontend/src/components/ProductCard.tsx
 M frontend/src/components/ai/types.ts
 M frontend/src/index.css
 M frontend/src/lib/analytics.ts
 M frontend/src/lib/carousel.test.ts
 M frontend/src/lib/carousel.ts
 M frontend/src/lib/telegram.ts
 M frontend/src/pages/ProductDetails.tsx
 M frontend/src/pages/Profile.tsx
?? .claude/
?? artifacts/
?? frontend/src/lib/pageSwipe.test.ts
?? frontend/src/lib/pageSwipe.ts
?? frontend/src/lib/usePageSwipe.ts

## Telegram webhook state (ДО изменений)
getWebhookInfo -> {"url": "", "has_custom_certificate": false, "pending_update_count": 0}
getMyCommands  -> []
getChatMenuButton -> {"type":"web_app","text":"Открыть магазин","web_app":{"url":"https://158.255.1.248.sslip.io/"}}

## production контейнеры (ДО изменений)
SERVICE    STATUS
admin      Up 12 hours
backend    Up 12 hours
caddy      Up 12 days
db         Up 12 days (healthy)
frontend   Up 12 hours

## production env — ИМЕНА переменных (значения секретов не сохраняются)
ADMIN_DOMAIN
ADMIN_EMAIL
ADMIN_PASSWORD
AI_CHAT_RATE_LIMIT_PER_MINUTE
AI_PROVIDER
ALLOWED_ORIGINS
APP_NAME
BOT_USERNAME
DATABASE_URL
DEV_MODE
DOMAIN
JWT_SECRET
MANAGER_RETAIL_URL
MANAGER_TRADEIN_URL
MANAGER_WHOLESALE_URL
MINI_APP_URL
POSTGRES_DB
POSTGRES_PASSWORD
POSTGRES_USER
TELEGRAM_BOT_TOKEN
TELEGRAM_CHANNEL_ID
TELEGRAM_CHANNEL_URL
WEBAPP_URL
