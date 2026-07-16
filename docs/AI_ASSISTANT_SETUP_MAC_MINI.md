# Настройка Mac mini M4 Pro (24 GB) для AI-консультанта

## 0. Предварительные проверки
```bash
sw_vers                     # macOS 14+
sysctl hw.memsize           # ≥ 24 ГБ
xcode-select --install      # CLT (если ещё нет; даст python3)
python3 --version           # 3.10+
```

## 1. Homebrew (если нет)
```bash
command -v brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
Альтернатива без brew: скачать Ollama.app с https://ollama.com/download (drag&drop),
тогда шаг 2 не нужен.

## 2. Ollama + модели
```bash
brew install ollama
ollama serve &              # или запусти Ollama.app (иконка в меню-баре)
ollama pull qwen3:14b       # основная модель (~9 ГБ, качаться будет долго)
ollama pull qwen3:8b        # быстрая вспомогательная (опционально)
ollama run qwen3:14b "Скажи 'готов' одним словом"   # smoke: модель отвечает
```
Проверка API: `curl http://127.0.0.1:11434/api/version` → JSON с версией.
⚠️ Ollama должна слушать только 127.0.0.1 (дефолт). НЕ ставь OLLAMA_HOST=0.0.0.0.

## 3. AI Gateway
Скопируй папку `ai-gateway/` из репозитория на Mac mini (например, в `~/ai-gateway`):
```bash
cd ~/ai-gateway
cp .env.example .env
openssl rand -hex 32        # сгенерируй ключ → впиши в .env AI_GATEWAY_API_KEY
nano .env                   # проверь модель/лимиты
bash run.sh                 # создаст venv, поставит зависимости, поднимет :8100
```
Проверка (в новом терминале): `bash health_check.sh` — 3 шага: Ollama → health → тестовый inference.

## 4. Автозапуск после перезагрузки (launchd — надёжнее Docker на macOS)
```bash
cd ~/ai-gateway
sed -i '' "s|__AI_GATEWAY_DIR__|$HOME/ai-gateway|g" com.aiseller.gateway.plist
cp com.aiseller.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.aiseller.gateway.plist
# статус: launchctl list | grep aiseller ; логи: tail -f ~/ai-gateway/gateway.log
```
Ollama.app сама умеет автозапуск (System Settings → Login Items → добавить Ollama).
Docker-вариант гейтвея есть (`ai-gateway/Dockerfile`), но launchd проще и без
виртуализации; в Docker не забудь `OLLAMA_BASE_URL=http://host.docker.internal:11434`.

## 5. Соединение VPS ↔ Mac mini (приватная сеть)
Рекомендуется **Tailscale** (бесплатно, WireGuard, не нужен белый IP):
```bash
# Mac mini:
brew install tailscale && sudo tailscaled install-system-daemon && tailscale up
tailscale ip -4            # например 100.101.102.103
# VPS (Ubuntu):
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```
Код к Tailscale не привязан: подойдёт любой приватный канал (WireGuard, SSH-туннель
`ssh -R`, Cloudflare Tunnel). Главное — Gateway НЕ должен быть доступен из интернета.

Проверка с VPS: `curl http://<tailscale-ip-мака>:8100/health` → `{"status":"ok","ollama":"ok"}`.

## 6. Включение на VPS (когда всё проверено)
В `/opt/techshop/.env` добавить:
```
AI_PROVIDER=ollama_remote
AI_GATEWAY_URL=http://<tailscale-ip-мака>:8100
AI_GATEWAY_API_KEY=<тот же ключ, что в ai-gateway/.env>
```
Перезапуск: `docker compose -f docker-compose.prod.yml up -d --force-recreate backend`.
Откат в один шаг: `AI_PROVIDER=fallback` + тот же рестарт.

## 7. Команды проверки (шпаргалка)
```bash
curl http://127.0.0.1:11434/api/version          # Ollama жива
curl http://127.0.0.1:8100/health                # Gateway жив
bash ~/ai-gateway/health_check.sh                # полная цепочка + inference
launchctl list | grep aiseller                   # автозапуск активен
tail -20 ~/ai-gateway/gateway.log                # логи гейтвея
```

## После перезагрузки Mac mini
При настроенном launchd (+ Ollama в Login Items) всё поднимется само.
Ручной порядок, если что-то не встало: открыть Ollama.app (или `ollama serve &`) →
`launchctl kickstart -k gui/$(id -u)/com.aiseller.gateway` → `bash health_check.sh`.
Первый запрос после старта медленный (модель грузится в unified memory) — это норма.
