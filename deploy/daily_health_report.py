#!/usr/bin/env python3
"""Ежедневная сводка о состоянии сервера — админу в Telegram.

Запускается НА ХОСТЕ (systemd-таймер, см. daily_health_report.timer), а не в
контейнере: половина отчёта — это диск, память и статусы самих контейнеров,
которых изнутри контейнера не видно. Пробрасывать в контейнер docker.sock ради
этого нельзя — доступ к нему равносилен правам root на хосте.

Токен и адрес админа берутся из /opt/techshop/.env — того же файла, которым
живёт сам магазин. Ничего не печатает в лог, кроме результата отправки: в
journalctl не должно попадать ни токена, ни chat_id.

Отчёт сознательно короткий. Ежедневное письмо, которое долго читать, перестают
читать на третий день, и тогда оно не спасает вообще ни от чего.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

ENV_PATH = "/opt/techshop/.env"
COMPOSE_PROJECT = "techshop"
#: Сервисы, отсутствие любого из которых — авария, а не мелочь.
EXPECTED = ["backend", "bot", "db", "frontend", "admin", "caddy"]


DB_USER = "postgres"
DB_NAME = "techshop"


def read_env(path: str) -> dict:
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


def containers() -> tuple[list[str], list[str]]:
    raw = run("docker", "ps", "--format", "{{.Names}}\t{{.Status}}")
    alive = {}
    for line in raw.splitlines():
        name, _, status = line.partition("\t")
        alive[name] = status
    up, down = [], []
    for service in EXPECTED:
        name = f"{COMPOSE_PROJECT}-{service}-1"
        status = alive.get(name, "")
        if status.startswith("Up"):
            up.append(service)
        else:
            down.append(service)
    return up, down


def disk_line() -> tuple[str, bool]:
    total, used, free = shutil.disk_usage("/")
    percent = used / total * 100
    return f"диск {percent:.0f}% занято, свободно {free // 2**30} ГБ", percent >= 85


def memory_line() -> tuple[str, bool]:
    fields = {}
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                fields[key] = int(rest.strip().split()[0]) // 1024
    except OSError:
        return "память: не прочиталась", True
    total = fields.get("MemTotal", 0)
    available = fields.get("MemAvailable", 0)
    swap_used = fields.get("SwapTotal", 0) - fields.get("SwapFree", 0)
    used_pct = (total - available) / total * 100 if total else 0
    return f"память {used_pct:.0f}%, swap {swap_used} МБ", used_pct >= 92


def load_line() -> tuple[str, bool]:
    one, five, _ = os.getloadavg()
    cores = os.cpu_count() or 1
    # Нагрузка выше числа ядер значит, что процессы стоят в очереди за CPU.
    return f"нагрузка {one:.1f} / {five:.1f} при {cores} ядрах", one > cores * 2


def bot_line() -> tuple[str, bool]:
    logs = run("docker", "logs", f"{COMPOSE_PROJECT}-bot-1", "--since", "24h")
    conflicts = len(re.findall(r"conflict", logs, re.I))
    errors = len(re.findall(r"\| ERROR \|", logs))
    if conflicts:
        return f"бот: {conflicts} конфликтов 409 — поднят второй экземпляр", True
    if errors:
        return f"бот: {errors} ошибок за сутки", errors >= 10
    return "бот: ошибок нет", False


def warp_line() -> tuple[str, bool]:
    status = run("warp-cli", "--accept-tos", "status")
    connected = "Connected" in status
    return ("WARP подключён" if connected else "WARP ОТВАЛИЛСЯ — Telegram недоступен"), not connected


def api_line(domain: str) -> tuple[str, bool]:
    if not domain:
        return "API: домен не настроен", True
    code = run("curl", "-sk", "-o", "/dev/null", "-w", "%{http_code} %{time_total}",
               f"https://{domain}/api/health")
    if not code:
        return "API: не ответил", True
    parts = code.split()
    status = parts[0]
    seconds = float(parts[1]) if len(parts) > 1 else 0.0
    return f"API: {status}, ответ {seconds * 1000:.0f} мс", status != "200"


def db_line() -> tuple[str, bool]:
    sql = ("select (select count(*) from products where is_active), "
           "(select count(*) from leads where created_at > now() - interval '24 hours'), "
           "(select count(*) from users), "
           "pg_size_pretty(pg_database_size(current_database()))")
    raw = run("docker", "exec", f"{COMPOSE_PROJECT}-db-1",
              "psql", "-U", DB_USER, "-d", DB_NAME, "-tAF", "|", "-c", sql)
    parts = raw.split("|")
    if len(parts) != 4:
        return "база: не опросилась", True
    products, leads, users, size = parts
    return f"база {size}: товаров {products}, пользователей {users}, заявок за сутки {leads}", False


def main() -> int:
    global DB_USER, DB_NAME

    env = read_env(ENV_PATH)
    DB_USER = env.get("POSTGRES_USER", "postgres")
    DB_NAME = env.get("POSTGRES_DB", "techshop")
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("ADMIN_TELEGRAM_ID", "")
    if not token or not chat_id:
        print("не настроены TELEGRAM_BOT_TOKEN или ADMIN_TELEGRAM_ID", file=sys.stderr)
        return 2

    up, down = containers()
    checks = [
        (f"сервисы {len(up)}/{len(EXPECTED)}" + (f", лежат: {', '.join(down)}" if down else ""), bool(down)),
        api_line(env.get("DOMAIN", "")),
        warp_line(),
        bot_line(),
        db_line(),
        disk_line(),
        memory_line(),
        load_line(),
    ]
    problems = [text for text, bad in checks if bad]
    head = "🔴 Сервер: есть проблемы" if problems else "🟢 Сервер в норме"
    body = "\n".join(f"{'🔴' if bad else '·'} {text}" for text, bad in checks)
    text = f"<b>{head}</b>\n\n{body}"
    if problems:
        text += "\n\nСтрочки с 🔴 требуют внимания."

    payload = json.dumps({
        "chat_id": chat_id, "text": text, "parse_mode": "HTML",
        # Тихое уведомление: ежедневная сводка не стоит звука в 10 утра.
        "disable_notification": not problems,
    }).encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload, headers={"Content-Type": "application/json"},
    )
    # Через тот же WARP, которым ходит бот: напрямую Telegram с этого VPS
    # недоступен, региональное ограничение хостера.
    proxy = env.get("TELEGRAM_PROXY_URL", "")
    try:
        if proxy:
            # urllib не умеет socks5, поэтому отправка идёт curl'ом — он умеет.
            result = run("curl", "-s", "--socks5-hostname", proxy.replace("socks5://", ""),
                         "-X", "POST", "-H", "Content-Type: application/json",
                         "-d", payload.decode(),
                         f"https://api.telegram.org/bot{token}/sendMessage",
                         timeout=60)
            sent = '"ok":true' in result
        else:
            with urllib.request.urlopen(request, timeout=30) as response:
                sent = response.status == 200
    except Exception as exc:  # noqa: BLE001
        print(f"отправка не удалась: {exc}", file=sys.stderr)
        return 1
    print("отчёт отправлен" if sent else "Telegram отклонил отправку", file=sys.stderr)
    return 0 if sent else 1


if __name__ == "__main__":
    raise SystemExit(main())
