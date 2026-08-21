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

#: Сколько уведомлений отправляем за один тик. Ограничение не техническое, а
#: против лимитов Telegram: пачка в сотню сообщений упрётся в 429 на середине.
#: Остаток уедет следующим тиком через ≤30 секунд — очередь никуда не денется.
OUTBOX_BATCH = 20

_running = True


#: Что фоновым задачам нужно от схемы: таблица -> обязательные колонки.
#:
#: Проверяются именно КОЛОНКИ, а не только наличие таблицы. Новые колонки
#: приезжают отдельными `ALTER TABLE ... ADD COLUMN` уже после create_all, то
#: есть ПОЗЖЕ своей таблицы: проверка «таблица существует» пропустила бы
#: `product_favorites` без `notified_price` и снова дала бы traceback на деплое.
#: Добавляешь фоновой задаче новое поле — добавь его сюда.
REQUIRED_SCHEMA: dict[str, tuple[str, ...]] = {
    "notifications": (),
    "product_favorites": ("notified_price", "notified_in_stock"),
    "carts": (),
    "fx_rate_history": (),
}


def _schema_ready(state: dict) -> bool:
    """Готова ли схема БД для фоновых задач.

    Схему создаёт и мигрирует backend на своём старте, а `depends_on` в compose
    ждёт только ЗАПУСКА контейнера, а не завершения его startup-события. При
    деплое со схемой бот успевает сделать первый тик раньше — и получает
    «relation/column does not exist».

    Сам по себе этот отказ безобиден (следующий тик через ≤30 с уже проходит),
    но полноэкранный traceback в логах на каждом деплое учит игнорировать логи
    бота — а это ровно то, из-за чего потом не замечают настоящую поломку.
    Поэтому ждём схему явно и говорим об этом одной строкой.

    Проверка выполняется, пока не увенчается успехом, после чего больше не
    повторяется: колонки не исчезают.
    """
    if state.get("schema_ready"):
        return True

    from sqlalchemy import inspect

    from app.db.session import engine

    inspector = inspect(engine)
    for table, columns in REQUIRED_SCHEMA.items():
        if not inspector.has_table(table):
            missing = table
            break
        present = {c["name"] for c in inspector.get_columns(table)}
        absent = [c for c in columns if c not in present]
        if absent:
            missing = f"{table}.{absent[0]}"
            break
    else:
        state["schema_ready"] = True
        return True

    if not state.get("schema_warned"):
        state["schema_warned"] = True
        logger.info("схема ещё не готова (%s) — фоновые задачи ждут backend", missing)
    return False


def _due(last: float | None, now: float, interval: float) -> bool:
    """Пора ли выполнять периодическую задачу.

    `last is None` = не выполняли ни разу с запуска процесса => пора. Отдельный
    сентинел нужен именно потому, что ноль в шкале time.monotonic() — это не
    «давно», а момент загрузки системы.
    """
    return last is None or now - last >= interval


def _warm_gateway(state: dict, now: float) -> None:
    """Держать serverless-функцию гейтвея тёплой.

    Замер с прода: холодный вызов `/api/v1/messages` — 6.0с ещё ДО обращения к
    модели, тёплый — 0.5с. Эти пять секунд платит первый человек после простоя,
    то есть ровно тот, кто только что открыл приложение и ждёт первый ответ.

    Греем обычным GET: функция отвечает на него 405 и до Anthropic не доходит —
    ни ключа в запросе, ни расхода токенов. Отдельного пингера (внешний cron,
    UptimeRobot) не заводим по той же причине, по которой в проекте нет
    планировщика: этот процесс уже крутится, а внешний сервис — ещё одна
    зависимость, о падении которой мы узнаем последними.
    """
    minutes = settings.AI_GATEWAY_WARM_MINUTES
    base = (settings.AI_ANTHROPIC_BASE_URL or "").strip().rstrip("/")
    # Греть имеет смысл только gateway: fallback отвечает из БД, а Ollama живёт
    # на Mac mini и холодным стартом не страдает.
    if minutes <= 0 or not base or settings.AI_PROVIDER.lower() != "anthropic":
        return
    if not _due(state.get("last_gateway_warm"), now, minutes * 60):
        return
    state["last_gateway_warm"] = now
    try:
        httpx.get(f"{base}/v1/messages", timeout=10)
    except Exception:  # noqa: BLE001 — прогрев необязателен, отказ не событие
        logger.debug("прогрев гейтвея не удался", exc_info=True)


def _tick(state: dict) -> None:
    """Фоновая работа между опросами Telegram (патч 1.1).

    Отдельного планировщика (cron / celery / APScheduler) в проекте нет и не
    заводится: этот процесс УЖЕ крутится постоянно с шагом ≤30 секунд, а каждый
    новый постоянный процесс — это ещё одна точка отказа и ещё один повод
    поймать 409 Conflict вторым экземпляром бота.

    Ошибки не выпускаем наружу: фоновые задачи не имеют права остановить приём
    сообщений — иначе уведомления сломают сам бот.
    """
    from app.core.config import settings
    from app.db.session import SessionLocal
    from app.services import cart_reminders, favorite_watch, fx_rate
    from app.services.notifications import drain

    now = time.monotonic()

    # Прогрев гейтвея — в своём try, ДО работы с БД: это необязательная
    # оптимизация, и её отказ не имеет права утащить за собой очередь
    # уведомлений. Ошибку глотаем молча (кроме debug): гейтвей может лежать,
    # это чинится сам собой к следующему интервалу.
    _warm_gateway(state, now)

    try:
        if not _schema_ready(state):
            return
        with SessionLocal() as db:
            # Сканы реже, чем опрос: ни корзина, ни цена не «протухают» за 30
            # секунд, а лишние проходы по базе бесполезны.
            # Отметку времени двигаем ПОСЛЕ успешного скана, а не до него.
            # Наоборот было ошибкой: упавший скан считался выполненным, и повтор
            # откладывался на целый интервал (час для избранного) вместо
            # следующего тика. Ровно это и произошло на деплое — скан упал на
            # ещё не добавленной колонке и «замолчал» на час.
            # Итог скана пишем ВСЕГДА, даже пустой. Раньше строка появлялась
            # только когда что-то поставлено в очередь, и «скан отработал, дел
            # нет» было неотличимо от «скан не запускался вовсе» — при разборе
            # «почему не пришло напоминание» это первый же вопрос, и ответа на
            # него в логах не было. Два скана в час — не тот объём, ради
            # которого стоит терять наблюдаемость.
            # «Ещё не сканировали» — это None, а не ноль. Ноль означал бы момент
            # времени, а time.monotonic() отсчитывается от старта СИСТЕМЫ: на
            # свежезагруженном хосте разница «сейчас минус ноль» меньше
            # интервала, и первый скан молча откладывался на 30-60 минут после
            # запуска. На проде с аптаймом в недели это не проявлялось.
            interval = max(1, settings.CART_REMINDER_SCAN_MINUTES) * 60
            if _due(state.get("last_scan"), now, interval):
                stats = cart_reminders.scan(db)
                state["last_scan"] = now
                logger.info("скан корзин: %s", stats)

            interval = max(1, settings.FAVORITE_WATCH_SCAN_MINUTES) * 60
            if _due(state.get("last_favorite_scan"), now, interval):
                stats = favorite_watch.scan(db)
                state["last_favorite_scan"] = now
                logger.info("скан избранного: %s", stats)

            # Отметку попытки двигаем при КАЖДОЙ попытке, а не только при
            # успехе: fx_rate.sync сам не бьёт по сети, если запись за сегодня
            # уже есть, но при недоступности ЦБ РФ (сеть легла, сервис не
            # отвечает) каждый провал без этого гейта повторял бы блокирующий
            # httpx.get(timeout=10) на каждом тике (≤30с) весь день — это до
            # 10с простоя опроса апдейтов на каждый тик. Порог — 5 минут между
            # ПОПЫТКАМИ, тот же _due, что и у прогрева гейтвея.
            if _due(state.get("last_fx_try"), now, 300):
                state["last_fx_try"] = now
                if fx_rate.sync(db):
                    logger.info("курс ЦБ РФ обновлён")

            stats = drain(db, limit=OUTBOX_BATCH)
            if stats["sent"] or stats["failed"]:
                logger.info("уведомления: %s", stats)
    except Exception:  # noqa: BLE001 — фон не роняет polling
        logger.exception("фоновая задача завершилась ошибкой")


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
        # Состояние фоновых задач живёт в локальной переменной, а не в модуле:
        # так его видно из сигнатуры и его нельзя случайно разделить между
        # двумя run() в тестах.
        tick_state: dict = {}

        while _running:
            _tick(tick_state)
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
                    message = update.get("message") or {}
                    chat_id = (message.get("chat") or {}).get("id")
                    if chat_id is None:
                        continue
                    # db=: чистый чат обязан пережить рестарт бота (на каждый
                    # деплой) — без сессии трекинг живёт только в памяти
                    # процесса и пропадает вместе с ней. См. telegram_bot.send_reply.
                    from app.db.session import SessionLocal
                    with SessionLocal() as db:
                        send_reply(chat_id, reply, incoming_message_id=message.get("message_id"), db=db)
                    logger.info("ответ отправлен в чат %s", chat_id)
                except Exception:  # noqa: BLE001 — один плохой апдейт не роняет бота
                    logger.exception("не удалось обработать апдейт %s", update.get("update_id"))

    logger.info("бот остановлен")
    return 0


if __name__ == "__main__":
    sys.exit(run())
