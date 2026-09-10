"""Настройка Telegram-бота на стороне Telegram (v5.5.0).

Запуск на сервере, из контейнера backend (там уже есть боевой .env):

    docker compose -f docker-compose.prod.yml exec -T backend python -m app.scripts.setup_bot

Делает две вещи, обе идемпотентные — повторный запуск безопасен:
  1. setMyCommands       — меню команд в клиенте Telegram;
  2. setChatMenuButton   — кнопка «Каталог» рядом с полем ввода (MENU_BUTTON_TEXT).

Вебхук ставится ТОЛЬКО по явному флагу `--webhook`, и это не педантизм.
Транспорт бота на проде — long polling (сеть хостинга режет входящие от
Telegram, см. bot_polling.py). Вебхук и getUpdates взаимоисключающи: как только
вебхук установлен, polling начинает получать 409 Conflict и бот замолкает —
до перезапуска контейнера, который снимает вебхук на старте. То есть невинная
на вид «донастройка команд» глушила бота, и связь между причиной и следствием
не видна ни в одном сообщении об ошибке.

`--dry-run` печатает, что будет отправлено, и ничего не меняет.

Про drop_pending_updates: НЕ включаем. Апдейты, накопившиеся до настройки
вебхука, — это реальные сообщения пользователей, и сбрасывать их молча значит
терять чужие обращения. Telegram доставит их сразу после setWebhook.
"""
from __future__ import annotations

import argparse
import json
import sys

import httpx

from app.core.config import settings
from app.services.telegram_bot import (
    BOT_COMMANDS,
    MENU_BUTTON_TEXT,
    TELEGRAM_API,
    telegram_http_kwargs,
)


#: Ключи payload, значения которых нельзя печатать. Вывод скрипта попадает в
#: логи деплоя и в переписку, а secret_token — это то единственное, чем вебхук
#: отличает настоящий апдейт Telegram от подделки.
_SECRET_KEYS = frozenset({"secret_token"})


def _redact(payload: dict) -> dict:
    return {k: ("<скрыто>" if k in _SECRET_KEYS else v) for k, v in payload.items()}


def _call(method: str, payload: dict, *, dry_run: bool) -> dict:
    if dry_run:
        print(f"[dry-run] {method} <- {json.dumps(_redact(payload), ensure_ascii=False)}")
        return {"ok": True, "result": "dry-run"}
    response = httpx.post(
        f"{TELEGRAM_API}/bot{settings.TELEGRAM_BOT_TOKEN}/{method}",
        json=payload,
        timeout=20,
        **telegram_http_kwargs(),
    )
    data = response.json()
    if not data.get("ok"):
        raise SystemExit(f"{method} отклонён Telegram: {data.get('description')}")
    return data


def webhook_url() -> str:
    base = (settings.MINI_APP_URL or "").strip().rstrip("/")
    return f"{base}/api/telegram/webhook"


def main() -> int:
    parser = argparse.ArgumentParser(description="Настроить Telegram-бота")
    parser.add_argument("--dry-run", action="store_true", help="только показать, ничего не менять")
    parser.add_argument(
        "--webhook", action="store_true",
        help="ТАКЖЕ поставить вебхук. ВНИМАНИЕ: заглушает long polling (409 Conflict) "
             "до перезапуска сервиса bot. Нужен, только если переходите на вебхук.",
    )
    args = parser.parse_args()

    required = [
        ("TELEGRAM_BOT_TOKEN", settings.TELEGRAM_BOT_TOKEN),
        ("MINI_APP_URL", settings.MINI_APP_URL),
    ]
    if args.webhook:
        required.append(("TELEGRAM_WEBHOOK_SECRET", settings.TELEGRAM_WEBHOOK_SECRET))
    missing = [name for name, value in required if not (value or "").strip()]
    if missing:
        print("Не заданы обязательные переменные: " + ", ".join(missing), file=sys.stderr)
        return 1
    if not webhook_url().startswith("https://"):
        print(f"MINI_APP_URL должен быть https, сейчас: {settings.MINI_APP_URL}", file=sys.stderr)
        return 1

    # Предупреждения, а не отказ: без этих ссылок бот работает, просто без кнопок.
    for name, value in (
        ("MANAGER_RETAIL_URL", settings.MANAGER_RETAIL_URL),
        ("TELEGRAM_CHANNEL_URL", settings.TELEGRAM_CHANNEL_URL),
    ):
        if not (value or "").strip():
            print(f"! {name} не задан — соответствующая кнопка показываться не будет")

    _call("setMyCommands", {
        "commands": [{"command": c, "description": d} for c, d in BOT_COMMANDS],
    }, dry_run=args.dry_run)
    print(f"✓ setMyCommands: {len(BOT_COMMANDS)} команд")

    _call("setChatMenuButton", {
        "menu_button": {
            "type": "web_app",
            "text": MENU_BUTTON_TEXT,
            "web_app": {"url": settings.MINI_APP_URL.rstrip("/") + "/"},
        },
    }, dry_run=args.dry_run)
    print(f"✓ setChatMenuButton: «{MENU_BUTTON_TEXT}» -> {settings.MINI_APP_URL}")

    if not args.webhook:
        print("• setWebhook пропущен: транспорт бота — long polling. "
              "Нужен вебхук — запустите с --webhook и перезапустите сервис bot.")
        return 0

    _call("setWebhook", {
        "url": webhook_url(),
        "secret_token": settings.TELEGRAM_WEBHOOK_SECRET,
        # Просим только то, что бот реально обрабатывает: личные сообщения.
        # Меньше лишнего трафика и меньше поводов для ошибок в обработчике.
        "allowed_updates": ["message"],
        "max_connections": 40,
    }, dry_run=args.dry_run)
    print(f"✓ setWebhook: {webhook_url()}")
    print("! long polling теперь получает 409 Conflict. Либо остановите сервис bot, "
          "либо снимите вебхук (перезапуск bot делает это автоматически).")

    if not args.dry_run:
        info = httpx.get(
            f"{TELEGRAM_API}/bot{settings.TELEGRAM_BOT_TOKEN}/getWebhookInfo", timeout=20,
            **telegram_http_kwargs(),
        ).json().get("result", {})
        # Токен в URL не печатаем — в нашей схеме его там нет, но подстрахуемся.
        safe = {k: v for k, v in info.items() if k != "url"}
        print("getWebhookInfo:", json.dumps(safe, ensure_ascii=False))
        print("webhook url:", info.get("url", "").replace(settings.TELEGRAM_BOT_TOKEN, "<TOKEN>"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
