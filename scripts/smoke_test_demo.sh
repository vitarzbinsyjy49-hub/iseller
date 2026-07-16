#!/usr/bin/env bash
# Smoke-test TechShop Demo MVP.
#
# Проверяет весь ключевой сценарий демо:
#   health -> dev login -> catalog -> product details -> AI chat (fallback)
#   -> lead creation -> admin leads -> analytics event -> catalog export.
#
# Использование:
#   BASE_URL=http://localhost:8000 \
#   ADMIN_EMAIL=admin@techshop.local ADMIN_PASSWORD=admin12345 \
#   CATALOG_EXPORT_API_KEY=change-me-catalog-key \
#   ./scripts/smoke_test_demo.sh
set -u

BASE_URL="${BASE_URL:-http://localhost:8000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@techshop.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin12345}"
CATALOG_EXPORT_API_KEY="${CATALOG_EXPORT_API_KEY:-change-me-catalog-key}"

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
info() { echo "— $1"; }

# Выбираем рабочий JSON-парсер один раз: jq -> python3 -> python.
# (На Windows python3 часто — заглушка WindowsApps, поэтому проверяем реальным импортом.)
PY=""
if ! command -v jq >/dev/null 2>&1; then
  if python3 -c "import json" >/dev/null 2>&1; then PY=python3
  elif python -c "import json" >/dev/null 2>&1; then PY=python
  else echo "Нужен jq или python (для разбора JSON)"; exit 2; fi
fi

json_get() {  # json_get '<json>' '<dot.path>'
  local json="$1" path="$2"
  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -r ".$path // empty" 2>/dev/null
  else
    echo "$json" | "$PY" -c "import sys,json
d=json.load(sys.stdin)
for k in '$path'.split('.'):
    if isinstance(d,list):
        try: d=d[int(k)]
        except: d=None
    else: d=d.get(k) if isinstance(d,dict) else None
    if d is None: break
print(d if d is not None else '')" 2>/dev/null
  fi
}

# POST/PATCH c JSON-телом через временный файл (--data-binary @file):
# на Windows (Git Bash) кириллица в argv для curl.exe ломается, файл — нет.
TMP_BODY="$(mktemp 2>/dev/null || echo /tmp/techshop_smoke_body.json)"
trap 'rm -f "$TMP_BODY"' EXIT

send_json() {  # send_json METHOD URL AUTH_HEADER JSON -> response body
  local method="$1" url="$2" auth="$3" json="$4"
  printf '%s' "$json" > "$TMP_BODY"
  curl -s -X "$method" "$url" -H "$auth" -H "Content-Type: application/json" --data-binary @"$TMP_BODY"
}

echo "=== TechShop Demo smoke-test: $BASE_URL ==="

# 1. health
info "1. backend health"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health")
[ "$code" = "200" ] && ok "health 200" || bad "health вернул $code"

# 2. dev login
info "2. dev login"
login=$(curl -s -X POST "$BASE_URL/api/auth/dev")
TOKEN=$(json_get "$login" "access_token")
[ -n "$TOKEN" ] && ok "получен JWT пользователя" || bad "dev login не вернул токен (DEV_MODE=true?)"
AUTH="Authorization: Bearer $TOKEN"

# 3. catalog list
info "3. catalog list"
cat=$(curl -s -H "$AUTH" "$BASE_URL/api/catalog/list?sort=popularity")
first_id=$(json_get "$cat" "cards.0.id")
[ -n "$first_id" ] && ok "каталог отдаёт товары (первый id=$first_id)" || bad "каталог пуст (seed выполнен?)"

# 4. product details
info "4. product details"
if [ -n "$first_id" ]; then
  det=$(curl -s -H "$AUTH" "$BASE_URL/api/catalog/product/$first_id")
  title=$(json_get "$det" "title")
  [ -n "$title" ] && ok "детали товара: $title" || bad "детали товара не получены"
else
  bad "нет id товара для проверки деталей"
fi

# 5. AI chat (fallback / demo)
info "5. AI chat"
chat=$(send_json POST "$BASE_URL/api/ai/chat" "$AUTH" '{"message":"ноутбук до 150 тысяч для монтажа"}')
src=$(json_get "$chat" "meta.source")
ncards=$(json_get "$chat" "cards.0.id")
if [ -n "$src" ]; then ok "AI ответил, source=$src, есть карточки=$([ -n "$ncards" ] && echo да || echo нет)";
else bad "AI chat не вернул meta.source"; fi

# 6. lead creation (с доставкой — v2)
info "6. lead creation"
lead=$(send_json POST "$BASE_URL/api/leads" "$AUTH" \
  "{\"name\":\"Тест\",\"phone\":\"+70000000000\",\"product_id\":$first_id,\"source\":\"ai\",\"message\":\"смоук-тест\",\"delivery_method\":\"pickup\"}")
lead_id=$(json_get "$lead" "id")
dm=$(json_get "$lead" "delivery_method")
[ -n "$lead_id" ] && ok "заявка создана №$lead_id (delivery=$dm)" || bad "заявка не создалась"

# 7. user leads (Мои заявки)
info "7. user leads"
my=$(curl -s -H "$AUTH" "$BASE_URL/api/leads/my")
my_id=$(json_get "$my" "leads.0.id")
[ -n "$my_id" ] && ok "заявка видна в «Мои заявки» (id=$my_id)" || bad "/leads/my пуст"

# 8. admin login + leads
info "8. admin leads"
alogin=$(curl -s -X POST "$BASE_URL/api/auth/admin/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
ATOKEN=$(json_get "$alogin" "access_token")
if [ -n "$ATOKEN" ]; then
  ok "admin login ок"
  AAUTH="Authorization: Bearer $ATOKEN"
  leads=$(curl -s -H "$AAUTH" "$BASE_URL/api/admin/leads")
  seen=$(json_get "$leads" "leads.0.id")
  [ -n "$seen" ] && ok "заявка видна в админке (id=$seen)" || bad "заявка не видна в админке"

  # 9. lead status update
  info "9. lead status update"
  upd=$(send_json PATCH "$BASE_URL/api/admin/leads/$lead_id" "$AAUTH" \
    '{"status":"in_progress","manager_comment":"смоук-тест: взяли в работу"}')
  st=$(json_get "$upd" "status")
  [ "$st" = "in_progress" ] && ok "статус заявки изменён -> $st" || bad "статус не изменился ($st)"

  # 10. product update (цена)
  info "10. product update"
  pupd=$(curl -s -X PATCH "$BASE_URL/api/admin/products/$first_id" -H "$AAUTH" -H "Content-Type: application/json" \
    -d '{"is_hot":true}')
  hot=$(json_get "$pupd" "is_hot")
  [ "$hot" = "True" ] || [ "$hot" = "true" ] && ok "товар обновлён (is_hot=true)" || bad "товар не обновился"

  # 11. stock update
  info "11. stock update"
  supd=$(curl -s -X PATCH "$BASE_URL/api/admin/products/$first_id/stock" -H "$AAUTH" -H "Content-Type: application/json" \
    -d '{"stock":7}')
  stv=$(json_get "$supd" "stock")
  [ "$stv" = "7" ] && ok "stock обновлён -> 7" || bad "stock не обновился ($stv)"

  # 12. product import (JSON)
  info "12. product import"
  imp=$(send_json POST "$BASE_URL/api/admin/products/import" "$AAUTH" \
    '[{"title":"Смоук-тест товар","sku":"SMOKE-1","category":"аксессуары","price":990,"stock":3}]')
  cr=$(json_get "$imp" "created"); up=$(json_get "$imp" "updated")
  { [ "$cr" = "1" ] || [ "$up" = "1" ]; } && ok "импорт: created=$cr updated=$up" || bad "импорт не сработал: $imp"

  # 13. dashboard
  info "13. admin dashboard"
  dash=$(curl -s -H "$AAUTH" "$BASE_URL/api/admin/dashboard")
  lt=$(json_get "$dash" "leads_total")
  [ -n "$lt" ] && ok "дашборд отвечает (leads_total=$lt)" || bad "дашборд не ответил"
else
  bad "admin login не удался (проверьте ADMIN_EMAIL/ADMIN_PASSWORD)"
fi

# 13b. v4: главная (баннеры + категории)
info "13b. home banners/categories (v4)"
homej=$(curl -s -H "$AUTH" "$BASE_URL/api/home")
b0=$(json_get "$homej" "banners.0.title")
c0=$(json_get "$homej" "categories.0.title")
[ -n "$b0" ] && [ -n "$c0" ] && ok "главная: баннер «$b0», категория «$c0»" || bad "/api/home пуст: $homej"

# 13c. v4: import preview (CSV, ничего не пишет в БД)
if [ -n "${ATOKEN:-}" ]; then
  info "13c. import preview CSV (v4)"
  # Файл кладём в текущую папку: пути /tmp из mktemp не читаются Windows-curl в -F
  CSV_TMP="./smoke_import_preview_$$.csv"
  printf 'sku,title,price,stock\nSMOKE-CSV-1,Смоук CSV товар,1990,2\n' > "$CSV_TMP"
  prev=$(curl -s -X POST "$BASE_URL/api/admin/import/products/preview" -H "$AAUTH" -F "file=@$CSV_TMP;type=text/csv")
  rm -f "$CSV_TMP"
  pc=$(json_get "$prev" "created"); pu=$(json_get "$prev" "updated")
  { [ "$pc" = "1" ] || [ "$pu" = "1" ]; } && ok "preview: created=$pc updated=$pu" || bad "preview не сработал: $prev"

  # 13d. v4: поиск с алиасом («плойка» -> playstation)
  info "13d. search alias (v4)"
  al=$(curl -s -H "$AUTH" "$BASE_URL/api/catalog/search?query=%D0%BF%D0%BB%D0%BE%D0%B9%D0%BA%D0%B0")
  al_id=$(json_get "$al" "cards.0.id")
  [ -n "$al_id" ] && ok "поиск «плойка» нашёл товар (id=$al_id)" || bad "алиас «плойка» не сработал"
fi

# 14. analytics event via /events
info "14. analytics event"
ev=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/events" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"event":"catalog_opened","payload":{}}')
[ "$ev" = "202" ] || [ "$ev" = "200" ] && ok "событие принято ($ev)" || bad "событие отклонено ($ev)"

# 15. catalog export без ключа / с ключом
info "15. catalog export"
c1=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/catalog/export")
{ [ "$c1" = "401" ] || [ "$c1" = "503" ]; } && ok "export без ключа -> $c1" || bad "export без ключа вернул $c1"
c2=$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: $CATALOG_EXPORT_API_KEY" "$BASE_URL/api/catalog/export")
[ "$c2" = "200" ] && ok "export с ключом -> 200" || bad "export с ключом вернул $c2"

echo ""
echo "=== ИТОГ: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] && { echo "SMOKE OK — демо-сценарий работает"; exit 0; } || { echo "SMOKE FAILED"; exit 1; }
