#!/usr/bin/env python3
"""Ежедневная сводка о состоянии сервера — админу в Telegram.

Запускается НА ХОСТЕ (systemd-таймер, см. daily_health_report.timer), а не в
контейнере: половина отчёта — это диск, память и статусы самих контейнеров,
которых изнутри контейнера не видно. Пробрасывать в контейнер docker.sock ради
этого нельзя — доступ к нему равносилен правам root на хосте.

Сами проверки и пороги живут в `health_checks.py`: их делит с этим отчётом
сторож `health_watch.py`, который пишет не по расписанию, а в момент поломки.
Две копии порогов неизбежно разъехались бы, и сводка спорила бы с тревогой.

Отчёт сознательно короткий. Ежедневное письмо, которое долго читать, перестают
читать на третий день, и тогда оно не спасает вообще ни от чего.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from health_checks import collect, read_env, send_telegram  # noqa: E402


def main() -> int:
    env = read_env()
    if not env.get("TELEGRAM_BOT_TOKEN") or not env.get("ADMIN_TELEGRAM_ID"):
        print("не настроены TELEGRAM_BOT_TOKEN или ADMIN_TELEGRAM_ID", file=sys.stderr)
        return 2

    checks = collect(env)
    problems = [check for check in checks if check.bad]
    head = "🔴 Сервер: есть проблемы" if problems else "🟢 Сервер в норме"
    body = "\n".join(f"{'🔴' if check.bad else '·'} {check.text}" for check in checks)
    text = f"<b>{head}</b>\n\n{body}"
    if problems:
        text += "\n\nСтрочки с 🔴 требуют внимания."

    # Тихое уведомление: ежедневная сводка не стоит звука в 10 утра.
    sent = send_telegram(env, text, silent=not problems)
    print("отчёт отправлен" if sent else "Telegram отклонил отправку", file=sys.stderr)
    return 0 if sent else 1


if __name__ == "__main__":
    raise SystemExit(main())
