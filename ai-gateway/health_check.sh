#!/usr/bin/env bash
# Быстрая проверка всей цепочки на Mac mini: Ollama -> Gateway -> модель.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && { set -a; source .env; set +a; }
PORT="${GATEWAY_PORT:-8100}"

echo "1) Ollama:"
curl -s --max-time 5 "${OLLAMA_BASE_URL:-http://127.0.0.1:11434}/api/version" && echo " OK" || echo " FAIL — запусти: ollama serve"

echo "2) Gateway health:"
curl -s --max-time 5 "http://127.0.0.1:${PORT}/health" || echo "FAIL — запусти: bash run.sh"
echo ""

echo "3) Тестовый inference (10-40 сек на первом запуске — модель грузится в память):"
curl -s --max-time 90 -X POST "http://127.0.0.1:${PORT}/v1/chat" \
  -H "X-API-Key: ${AI_GATEWAY_API_KEY}" -H "Content-Type: application/json" \
  -d '{"system":"Отвечай строго JSON: {\"ok\": true, \"echo\": \"<текст>\"}","message":"привет","history":[],"candidates":[]}' \
  | head -c 400
echo ""
