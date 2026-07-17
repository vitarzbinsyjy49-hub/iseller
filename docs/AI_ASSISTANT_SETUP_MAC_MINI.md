# Настройка Mac mini M4 Pro (24 GB) для AI-консультанта (v5.1)

## 0. Предварительные проверки
```bash
sw_vers                     # macOS 14+
sysctl hw.memsize           # ≥ 24 ГБ (25769803776)
python3 --version           # 3.10+ (если нет — xcode-select --install)
```

## 1. Ollama (официальный путь — приложение)
1. Скачай **Ollama.dmg** с https://ollama.com/download → перетащи в Applications → запусти.
   Иконка появится в меню-баре; фоновый сервер поднимется сам на `127.0.0.1:11434`.
2. Автозапуск: System Settings → General → Login Items → добавь Ollama.
3. Модели (первая ~9.3 ГБ, качается долго):
```bash
ollama pull qwen3:14b       # основная
ollama pull qwen3:8b        # быстрая вспомогательная (опционально)
ollama run qwen3:14b "Скажи 'готов' одним словом"   # smoke
curl http://127.0.0.1:11434/api/version              # API отвечает
```
Альтернатива для любителей CLI: `brew install ollama && brew services start ollama`
(тоже рабочий путь, но обновления удобнее через .app).

⚠️ Ollama должна слушать только 127.0.0.1 (это дефолт). НЕ задавай `OLLAMA_HOST=0.0.0.0`.

## 2. Tailscale (приватная сеть VPS ↔ Mac mini)
Официальные варианты для macOS — **standalone-пакет** (рекомендован Tailscale) или App Store:
1. Скачай с https://tailscale.com/download/macos (standalone) → установи → войди в аккаунт.
2. CLI в standalone-версии доступен как `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
   (можно сделать alias). В App Store-версии CLI включается в настройках приложения
   (Settings → включить «Run CLI»).
3. Узнай IP мака: меню Tailscale → скопировать IP (вид `100.x.y.z`), либо CLI `tailscale ip -4`.

На VPS (Ubuntu):
```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```
Код к Tailscale не привязан: подойдёт любой приватный канал (WireGuard, SSH-туннель).
Главное правило: **Gateway не должен быть доступен из публичного интернета.**

## 3. AI Gateway
Скопируй папку `ai-gateway/` из репозитория на Mac mini (например, в `~/ai-gateway`):
```bash
cd ~/ai-gateway
cp .env.example .env
openssl rand -hex 32        # ключ → в .env AI_GATEWAY_API_KEY
nano .env                   # ВАЖНО: GATEWAY_BIND=<tailscale-ip мака> (например 100.101.102.103)
bash run.sh                 # venv + зависимости + запуск
```
`GATEWAY_BIND` по умолчанию `127.0.0.1` (только локально). Для доступа с VPS укажи
**Tailscale-IP** — гейтвей будет слушать только приватный интерфейс, не 0.0.0.0.

Проверка: `bash health_check.sh` — Ollama → liveness → readiness (модель скачана) → тестовый inference.

## 4. Автозапуск gateway после перезагрузки (launchd)
```bash
cd ~/ai-gateway
sed -i '' "s|__AI_GATEWAY_DIR__|$HOME/ai-gateway|g" com.aiseller.gateway.plist
cp com.aiseller.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.aiseller.gateway.plist
# статус: launchctl list | grep aiseller ; логи: tail -f ~/ai-gateway/gateway.log
```
Docker-вариант есть (`ai-gateway/Dockerfile`), но launchd проще; в Docker понадобится
`OLLAMA_BASE_URL=http://host.docker.internal:11434`.

## 5. Прогрев модели (после перезагрузки/простоя)
Первый inference грузит модель в память (10–30 с). Чтобы пользователь этого не ждал:
```bash
curl -s http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen3:14b","prompt":"","keep_alive":"30m"}' >/dev/null
```
Gateway передаёт `keep_alive=30m` с каждым запросом — при живом трафике модель
остаётся в памяти сама.

## 6. Проверка связки с VPS
```bash
# с VPS:
curl http://<tailscale-ip-мака>:8100/health    # {"status":"ok"} — процесс жив
curl http://<tailscale-ip-мака>:8100/ready     # {"status":"ready",...} — Ollama + модель
```
`/ready` — главный критерий: он проверяет и доступность Ollama, и что модель скачана.

## 7. Включение на VPS (когда /ready зелёный)
В `/opt/techshop/.env`:
```
AI_PROVIDER=ollama_remote
AI_GATEWAY_URL=http://<tailscale-ip-мака>:8100
AI_GATEWAY_API_KEY=<тот же ключ, что в ai-gateway/.env>
```
`docker compose -f docker-compose.prod.yml up -d --force-recreate backend`.
Откат в один шаг: `AI_PROVIDER=fallback` + тот же рестарт.

## Таймауты (важно соблюдать иерархию)
```
Ollama inference (gateway AI_TIMEOUT_SECONDS) = 45с
  < backend AI_GATEWAY_TIMEOUT_SECONDS       = 55с
    < frontend AbortController               = 60с
```

## Шпаргалка «после перезагрузки Mac mini»
При настроенных Login Items (Ollama) + launchd (gateway) всё поднимется само.
Вручную: открыть Ollama.app → `launchctl kickstart -k gui/$(id -u)/com.aiseller.gateway`
→ прогрев (п.5) → `bash ~/ai-gateway/health_check.sh`.
