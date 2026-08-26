"""Проверка живого бота на проде. ТОЛЬКО ЧТЕНИЕ — ничего не отправляет.

Запускать внутри контейнера backend (там настройки, токен и прокси):

    docker exec techshop-backend-1 python /tmp/prod_bot_smoke.py

Проверяет ровно то, чего не видят обычные тесты: они мокают сеть и потому
одинаково зелены и когда прокси жив, и когда он лежит.

Что здесь НЕ проверяется и почему:
- доставка сообщений человеку — для этого нужно кому-то написать, а скрипт
  сознательно ничего не отправляет;
- дубль второго экземпляра бота — снаружи он не виден. Его признак это 409 в
  логах САМОГО бота (`docker logs techshop-bot-1 | grep Conflict`), потому что
  проигравший getUpdates получает отказ у себя, а не у нас.
"""
import statistics
import sys
import time

sys.path.insert(0, "/code")

import httpx

from app.core.config import settings
from app.services.telegram_bot import reply_for_payload, resolve_payload_path

PASS, FAIL, WARN = [], [], []


def ok(msg: str) -> None:
    PASS.append(msg)
    print(f"  [ok]   {msg}")


def bad(msg: str) -> None:
    FAIL.append(msg)
    print(f"  [FAIL] {msg}")


def warn(msg: str) -> None:
    WARN.append(msg)
    print(f"  [warn] {msg}")


def api(method: str, params: dict | None = None, timeout: float = 20.0) -> dict:
    """Вызов Bot API через тот же прокси, которым ходит бот."""
    url = f"https://api.telegram.org/bot{settings.TELEGRAM_BOT_TOKEN}/{method}"
    proxy = (settings.TELEGRAM_PROXY_URL or "").strip() or None
    with httpx.Client(timeout=timeout, proxy=proxy) as client:
        response = client.post(url, json=params or {})
    return response.json()


# --------------------------------------------------------------- 1. токен жив
print("— бот и прокси")
try:
    me = api("getMe")
    if me.get("ok"):
        ok(f"getMe: @{me['result'].get('username')} через прокси {settings.TELEGRAM_PROXY_URL or 'без прокси'}")
    else:
        bad(f"getMe вернул {me}")
except Exception as exc:  # noqa: BLE001 — здесь важен сам факт недоступности
    bad(f"getMe не прошёл: {exc}")

# --------------------------------------------------- 2. вебхука быть не должно
try:
    hook = api("getWebhookInfo")
    hook_url = (hook.get("result") or {}).get("url") or ""
    if hook_url:
        bad(f"вебхук установлен ({hook_url}) — он до нас не доходит, бот обязан жить на long polling")
    else:
        ok("вебхук снят, бот на long polling")
except Exception as exc:  # noqa: BLE001
    bad(f"getWebhookInfo не прошёл: {exc}")

# ------------------------------------------- 3. устойчивость прокси, 20 попыток
print("— устойчивость прокси (20 запросов)")
lat: list[float] = []
fails = 0
for _ in range(20):
    started = time.monotonic()
    try:
        result = api("getMe", timeout=15.0)
        if not result.get("ok"):
            fails += 1
        else:
            lat.append((time.monotonic() - started) * 1000)
    except Exception:  # noqa: BLE001 — считаем именно срывы, детали не нужны
        fails += 1
if lat:
    line = (f"успешных {len(lat)}/20, медиана {statistics.median(lat):.0f} мс, "
            f"худший {max(lat):.0f} мс")
    if fails == 0:
        ok(f"прокси стабилен: {line}")
    elif fails <= 2:
        warn(f"прокси иногда срывается ({fails}/20) — ретраи это чинят: {line}")
    else:
        bad(f"прокси срывается часто ({fails}/20): {line}")
else:
    bad("прокси недоступен: ни один из 20 запросов не прошёл")

# ---------------------------------------------------------- 4. long polling
# Пробный getUpdates отсюда УБРАН намеренно. Он не отвечает на вопрос «жив ли
# бот»: Telegram отдаёт слот одному потребителю, поэтому успешный ответ значит
# лишь то, что слот в этот миг отобрали МЫ — то есть проверка сама рвёт живому
# боту опрос. Признак второго экземпляра ищется в логах самого бота
# (`docker logs techshop-bot-1 | grep -i conflict`), там его видит проигравший.

# ------------------------------------------------ 5. диплинки: бот и Mini App
print("— диплинки")
PAYLOADS = ["catalog", "ai", "requests", "sell", "marketplace", "roadmap"]
for payload in PAYLOADS:
    route = resolve_payload_path(payload)
    reply = reply_for_payload(payload)
    if route is None:
        bad(f"payload {payload}: Mini App не знает такого маршрута")
        continue
    urls = [b["web_app"]["url"] for row in (reply.keyboard if reply else []) for b in row if "web_app" in b]
    if not urls:
        bad(f"payload {payload}: бот отвечает без web_app-кнопки")
    elif not any(u.endswith(route) for u in urls):
        bad(f"payload {payload}: бот ведёт на {urls}, а Mini App на {route}")
    else:
        ok(f"payload {payload} -> {route}")

# ----------------------------------------------------- 6. публичный API живой
print("— публичный API")
base = (settings.MINI_APP_URL or "").strip().rstrip("/")
if not base:
    warn("MINI_APP_URL не настроен — пропускаю проверки по публичному адресу")
else:
    with httpx.Client(timeout=20.0, verify=False) as client:  # noqa: S501 — sslip.io, свой сертификат
        for path in ("/api/health", "/api/config/public", "/api/deeplink/roadmap"):
            try:
                response = client.get(f"{base}{path}")
                if response.status_code == 200:
                    ok(f"{path} -> 200")
                else:
                    bad(f"{path} -> {response.status_code}")
            except Exception as exc:  # noqa: BLE001
                bad(f"{path} не ответил: {exc}")

print()
print(f"итог: ok {len(PASS)}, warn {len(WARN)}, fail {len(FAIL)}")
for line in FAIL:
    print("  FAIL:", line)
for line in WARN:
    print("  warn:", line)
sys.exit(1 if FAIL else 0)
