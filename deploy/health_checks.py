#!/usr/bin/env python3
"""Проверки состояния сервера — общая часть суточной сводки и сторожа.

Два потребителя с разными задачами:

* `daily_health_report.py` — раз в сутки, «как дела вообще». Ему интересны и
  медленные тревоги: диск забился на 85%, у бота накопились ошибки.
* `health_watch.py` — раз в две минуты, «всё ли горит». Ему интересно только
  то, ради чего не жалко разбудить: сервис лёг, API не отвечает, WARP отвалился.

Поэтому у проверки ДВА независимых флага: `bad` (попадёт в суточную сводку
красной строкой) и `urgent` (поднимет тревогу немедленно). Диск на 85% — `bad`,
но не `urgent`: за сутки он не переполнится, а будить среди дня незачем.
Пороги разъезжаться не должны, поэтому живут здесь, а не у каждого скрипта
своя копия.

Ни одна проверка не бросает исключений: отчёт про сломанный сервер нужен
именно тогда, когда что-то сломано, и упавшая проверка не имеет права утащить
за собой остальные семь.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass

ENV_PATH = "/opt/techshop/.env"
COMPOSE_PROJECT = "techshop"
#: Сервисы, отсутствие любого из которых — авария, а не мелочь.
EXPECTED = ["backend", "bot", "db", "frontend", "admin", "caddy"]

#: Пороги. Слева — «написать в суточной сводке», справа — «поднять тревогу».
#: Второй порог всегда выше: тревога стоит внимания человека, строчка в
#: сводке — нет.
DISK_BAD_PCT, DISK_URGENT_PCT = 85.0, 95.0
MEM_BAD_PCT, MEM_URGENT_PCT = 92.0, 96.0
#: Нагрузка выше числа ядер значит, что процессы стоят в очереди за CPU.
#: Двукратная — повод посмотреть, трёхкратная — повод вмешаться.
LOAD_BAD_FACTOR, LOAD_URGENT_FACTOR = 2, 3
#: Ошибки бота за сутки: десяток — уже система, а не случайность. В тревогу не
#: выносим совсем — бот переживает ошибку и работает дальше.
BOT_ERRORS_BAD = 10


@dataclass
class Check:
    key: str        # стабильный идентификатор: по нему сторож помнит состояние
    text: str       # готовая строка для человека
    bad: bool       # красная строка в суточной сводке
    urgent: bool = False   # повод написать немедленно


def read_env(path: str = ENV_PATH) -> dict:
    values = {}
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    values[key.strip()] = value.strip()
    except OSError:
        pass
    return values


def run(*args: str, timeout: int = 30) -> str:
    """Команда хоста. Упавшая команда не должна ронять весь отчёт: отчёт про
    сломанный сервер нужнее всего именно тогда, когда что-то сломано."""
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return (out.stdout or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def services_check() -> Check:
    raw = run("docker", "ps", "--format", "{{.Names}}\t{{.Status}}")
    alive = {}
    for line in raw.splitlines():
        name, _, status = line.partition("\t")
        alive[name] = status
    up, down = [], []
    for service in EXPECTED:
        status = alive.get(f"{COMPOSE_PROJECT}-{service}-1", "")
        (up if status.startswith("Up") else down).append(service)
    text = f"сервисы {len(up)}/{len(EXPECTED)}"
    if down:
        text += f", лежат: {', '.join(down)}"
    return Check("services", text, bool(down), bool(down))


def api_check(domain: str) -> Check:
    if not domain:
        return Check("api", "API: домен не настроен", True, False)
    code = run("curl", "-sk", "-o", "/dev/null", "-w", "%{http_code} %{time_total}",
               f"https://{domain}/api/health")
    if not code:
        return Check("api", "API: не ответил", True, True)
    parts = code.split()
    status = parts[0]
    seconds = float(parts[1]) if len(parts) > 1 else 0.0
    down = status != "200"
    return Check("api", f"API: {status}, ответ {seconds * 1000:.0f} мс", down, down)


def warp_check() -> Check:
    status = run("warp-cli", "--accept-tos", "status")
    connected = "Connected" in status
    text = "WARP подключён" if connected else "WARP ОТВАЛИЛСЯ — Telegram недоступен"
    return Check("warp", text, not connected, not connected)


def bot_check(window: str = "24h") -> Check:
    """Ошибки бота в логах за `window`.

    Окно — параметр, потому что сторож ходит сюда раз в две минуты, а суточной
    сводке нужны сутки: перечитывать день логов каждые две минуты — это заметная
    нагрузка на диск ради данных, которые всё равно не изменились.

    409 Conflict — единственная срочная строка: он означает второй запущенный
    экземпляр бота, и пока он жив, сообщения покупателей теряются.
    """
    logs = run("docker", "logs", f"{COMPOSE_PROJECT}-bot-1", "--since", window)
    conflicts = len(re.findall(r"conflict", logs, re.I))
    errors = len(re.findall(r"\| ERROR \|", logs))
    if conflicts:
        return Check("bot", f"бот: {conflicts} конфликтов 409 — поднят второй экземпляр",
                     True, True)
    if errors:
        suffix = "за сутки" if window == "24h" else f"за {window}"
        return Check("bot", f"бот: {errors} ошибок {suffix}", errors >= BOT_ERRORS_BAD, False)
    return Check("bot", "бот: ошибок нет", False, False)


def db_check(user: str, name: str) -> Check:
    sql = ("select (select count(*) from products where is_active), "
           "(select count(*) from leads where created_at > now() - interval '24 hours'), "
           "(select count(*) from users), "
           "pg_size_pretty(pg_database_size(current_database()))")
    raw = run("docker", "exec", f"{COMPOSE_PROJECT}-db-1",
              "psql", "-U", user, "-d", name, "-tAF", "|", "-c", sql)
    parts = raw.split("|")
    if len(parts) != 4:
        return Check("db", "база: не опросилась", True, True)
    products, leads, users, size = parts
    return Check("db", f"база {size}: товаров {products}, пользователей {users}, "
                       f"заявок за сутки {leads}", False, False)


def disk_check() -> Check:
    total, used, free = shutil.disk_usage("/")
    percent = used / total * 100
    return Check("disk", f"диск {percent:.0f}% занято, свободно {free // 2**30} ГБ",
                 percent >= DISK_BAD_PCT, percent >= DISK_URGENT_PCT)


def memory_check() -> Check:
    fields = {}
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                fields[key] = int(rest.strip().split()[0]) // 1024
    except OSError:
        return Check("memory", "память: не прочиталась", True, False)
    total = fields.get("MemTotal", 0)
    available = fields.get("MemAvailable", 0)
    swap_used = fields.get("SwapTotal", 0) - fields.get("SwapFree", 0)
    used_pct = (total - available) / total * 100 if total else 0
    return Check("memory", f"память {used_pct:.0f}%, swap {swap_used} МБ",
                 used_pct >= MEM_BAD_PCT, used_pct >= MEM_URGENT_PCT)


def load_check() -> Check:
    one, five, _ = os.getloadavg()
    cores = os.cpu_count() or 1
    return Check("load", f"нагрузка {one:.1f} / {five:.1f} при {cores} ядрах",
                 one > cores * LOAD_BAD_FACTOR, one > cores * LOAD_URGENT_FACTOR)


def collect(env: dict, *, bot_window: str = "24h") -> list[Check]:
    """Все проверки в том порядке, в каком их читает человек: сначала «живо ли
    вообще», потом «сколько ресурсов осталось»."""
    return [
        services_check(),
        api_check(env.get("DOMAIN", "")),
        warp_check(),
        bot_check(bot_window),
        db_check(env.get("POSTGRES_USER", "postgres"), env.get("POSTGRES_DB", "techshop")),
        disk_check(),
        memory_check(),
        load_check(),
    ]


def send_telegram(env: dict, text: str, *, silent: bool) -> bool:
    """Сообщение админу. Возвращает True, если Telegram принял.

    Идёт через тот же SOCKS-прокси WARP, что и бот: напрямую Telegram с этого
    VPS недоступен (региональное ограничение хостера). urllib не умеет socks5,
    поэтому отправка — curl'ом.

    Токен лежит в ПУТИ URL Bot API, поэтому ни сама строка запроса, ни ответ
    curl'а наружу не печатаются: journalctl читается без прав на .env.
    """
    import json
    import urllib.request

    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("ADMIN_TELEGRAM_ID", "")
    if not token or not chat_id:
        return False
    payload = json.dumps({
        "chat_id": chat_id, "text": text, "parse_mode": "HTML",
        "disable_notification": silent,
    }).encode()
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    proxy = env.get("TELEGRAM_PROXY_URL", "")
    try:
        if proxy:
            result = run("curl", "-s", "--socks5-hostname", proxy.replace("socks5://", ""),
                         "-X", "POST", "-H", "Content-Type: application/json",
                         "-d", payload.decode(), url, timeout=60)
            return '"ok":true' in result
        request = urllib.request.Request(
            url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status == 200
    except Exception:  # noqa: BLE001
        return False
