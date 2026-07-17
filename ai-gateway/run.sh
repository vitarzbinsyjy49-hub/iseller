#!/usr/bin/env bash
# Запуск AI Gateway на Mac mini (локально, без Docker).
# Использование: bash run.sh   (из папки ai-gateway)
set -euo pipefail
cd "$(dirname "$0")"

# --- проверки окружения ---
if ! command -v python3 >/dev/null; then
  echo "!! python3 не найден. Установи Xcode CLT: xcode-select --install (или brew install python)"; exit 1
fi
if [ ! -f .env ]; then
  echo "!! Нет .env. Скопируй: cp .env.example .env и заполни AI_GATEWAY_API_KEY"; exit 1
fi

# --- venv + зависимости ---
if [ ! -d .venv ]; then python3 -m venv .venv; fi
source .venv/bin/activate
pip install -q -r requirements.txt

# --- env + запуск ---
set -a; source .env; set +a
PORT="${GATEWAY_PORT:-8100}"
# Безопасный дефолт: слушаем только localhost. Для VPS-доступа задай в .env
# GATEWAY_BIND=<tailscale-ip> — приватный интерфейс, а не 0.0.0.0.
BIND="${GATEWAY_BIND:-127.0.0.1}"
echo ">> AI Gateway на ${BIND}:${PORT} (модель: ${OLLAMA_CHAT_MODEL:-qwen3:14b})"
exec uvicorn main:app --host "$BIND" --port "$PORT"
