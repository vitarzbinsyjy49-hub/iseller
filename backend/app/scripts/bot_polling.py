"""Приём апдейтов Telegram через long polling (v5.5.1).

Почему не вебхук. Сеть хостинга режет трафик Telegram В ОБЕ СТОРОНЫ: исходящие
запросы к api.telegram.org лечатся прокси (TELEGRAM_PROXY_URL), но входящие
соединения от серверов Telegram к нашему IP не проходят — вебхук получал
«Connection timed out», а сообщения копились в очереди Telegram недоставленными.
Polling переворачивает направление: соединение инициируем МЫ, тем же исходящим
каналом, который уже работает. Вебхук-роут при этом остаётся в коде рабочим —
если сеть однажды перестанет резать входящие, вернуться к нему можно одной
командой setWebhook.

Запускается как отдельный сервис `bot` в docker-compose.prod.yml.

ВАЖНО: экземпляр должен быть ровно один. Два параллельных getUpdates по одному
токену Telegram отвергает с ошибкой 409 Conflict; поэтому у сервиса не должно
быть реплик, и вебхук обязан быть снят (deleteWebhook) — иначе getUpdates
конфликтует уже с ним.
"""
from __future__ import annotations

import logging
import signal
import sys
import time
from types import FrameType

import httpx

from app.core.config import settings
from app.core.logging import setup_logging
from app.services.telegram_bot import (
    TELEGRAM_API,
    build_reply,
    send_reply,
    telegram_http_kwargs,
)

setup_logging()
logger = logging.getLogger("techshop.bot")

LONG_POLL_SECONDS = 30
# Пауза после сетевого сбоя: растёт до потолка, чтобы при долгой недоступности
# Telegram не долбить его в цикле без передышки.
BACKOFF_START = 2
BACKOFF_MAX = 60

_running = True


def _stop(signum: int, _frame: FrameType | None) -> None:
    """SIGTERM от docker: дорабатываем текущую итерацию и выходим чисто."""
    global _running
    logger.info("получен сигнал %s, останавливаюсь", signum)
    _running = False


def _api(method: str, client: httpx.Client, **params) -> dict:
    response = client.get(f"/bot{settings.TELEGRAM_BOT_TOKEN}/{method}", params=params)
    return response.json()


def run() -> int:
    if not settings.TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN не задан — бот не запускается")
        return 1

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    kwargs = telegram_http_kwargs()
    logger.info("бот стартует, прокси: %s", kwargs.get("proxy") or "нет (прямое соединение)")

    # Таймаут чтения заведомо больше long-poll: сервер держит соединение до
    # LONG_POLL_SECONDS, и обрывать его раньше значило бы терять апдейты.
    timeout = httpx.Timeout(LONG_POLL_SECONDS + 15, connect=20)
    with httpx.Client(base_url=TELEGRAM_API, timeout=timeout, **kwargs) as client:
        # Вебхук и getUpdates взаимоисключающи: пока вебхук установлен, Telegram
        # отвечает на getUpdates ошибкой 409. Снимаем его на старте, но НЕ
        # сбрасываем накопленные апдейты — это реальные сообщения людей.
        try:
            data = _api("deleteWebhook", client, drop_pending_updates=False)
            logger.info("deleteWebhook: ok=%s", data.get("ok"))
        except httpx.HTTPError as exc:
            logger.warning("не удалось снять вебхук на старте: %s", exc)

        offset: int | None = None
        backoff = BACKOFF_START

        while _running:
            try:
                params = {"timeout": LONG_POLL_SECONDS, "allowed_updates": '["message"]'}
                if offset is not None:
                    params["offset"] = offset
                data = _api("getUpdates", client, **params)
            except httpx.HTTPError as exc:
                logger.warning("сеть недоступна (%s), повтор через %s с", exc, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX)
                continue

            if not data.get("ok"):
                description = data.get("description", "")
                # 409 означает второй экземпляр бота или невыключенный вебхук —
                # состояние, которое само не рассосётся, поэтому кричим громко.
                level = logging.ERROR if "conflict" in description.lower() else logging.WARNING
                logger.log(level, "getUpdates отклонён: %s", description)
                time.sleep(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX)
                continue

            backoff = BACKOFF_START
            for update in data.get("result", []):
                # offset двигаем ДО обработки: апдейт, на котором обработчик
                # падает, не должен возвращаться вечно и блокировать очередь.
                offset = update["update_id"] + 1
                try:
                    reply = build_reply(update)
                    if reply is None:
                        continue
                    chat_id = ((update.get("message") or {}).get("chat") or {}).get("id")
                    if chat_id is None:
                        continue
                    send_reply(chat_id, reply)
                    logger.info("ответ отправлен в чат %s", chat_id)
                except Exception:  # noqa: BLE001 — один плохой апдейт не роняет бота
                    logger.exception("не удалось обработать апдейт %s", update.get("update_id"))

    logger.info("бот остановлен")
    return 0


if __name__ == "__main__":
    sys.exit(run())
