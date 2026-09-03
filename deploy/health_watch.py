#!/usr/bin/env python3
"""Сторож: пишет админу в Telegram, когда что-то СЛОМАЛОСЬ, а не раз в сутки.

Суточная сводка (`daily_health_report.py`) отвечает на вопрос «как дела», но
если backend лёг в 14:00, узнать об этом в 10:00 следующего дня — поздно.
Сторож ходит раз в две минуты и пишет в момент поломки.

Всё остальное здесь — про то, чтобы он при этом НЕ СПАМИЛ. Сторож, который
пишет на каждое дрожание, читается ровно неделю, а потом его уведомления
начинают смахивать не глядя — и настоящая авария проходит мимо вместе с шумом.
Поэтому:

* **Подтверждение.** Тревога уходит не с первой неудачной проверки, а с
  `CONFIRM`-й подряд. Одиночный таймаут curl'а или секунда, пока контейнер
  перезапускается, до человека не доезжают вообще.
* **Одно сообщение на проблему.** Пока проблема жива, повторов нет. Не «API
  лежит» каждые две минуты, а один раз — и всё.
* **Напоминание раз в `REMIND`.** Обратная сторона предыдущего пункта: про
  проблему, о которой написали один раз в три ночи, легко забыть. Раз в шесть
  часов сторож напоминает, что всё ещё горит.
* **Отбой.** Когда всё починилось — одно сообщение «восстановилось», и тихо.
  Отбой тоже требует `CONFIRM` подтверждений: иначе мигающая проверка
  устроила бы переписку «упало / поднялось» каждые четыре минуты.
* **Пауза на время деплоя.** `update-server.sh` пересобирает стек, и на минуту
  контейнеров действительно нет. Это не авария, а наши собственные действия,
  поэтому деплой ставит файл-паузу, и сторож это время молчит.

Решение о том, писать ли и что именно, принимает `decide()` — чистая функция
без файлов, сети и времени внутри. Тесты (`backend/tests/test_health_watch.py`)
гоняют именно её: у сторожа вся сложность в этой логике, а не в сборе цифр.
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from health_checks import Check, collect, read_env, send_telegram  # noqa: E402

STATE_PATH = "/var/lib/techshop/health_watch.json"
#: Деплой пересобирает стек — контейнеров на минуту нет, и это не авария.
#: Файл ставит update-server.sh, внутри — unix-время, до которого молчим.
PAUSE_PATH = "/run/techshop-health.pause"

#: Сколько проверок подряд должны сойтись, чтобы поверить. При таймере в две
#: минуты это ~4 минуты до тревоги — достаточно быстро, чтобы узнать первым,
#: и достаточно медленно, чтобы не реагировать на моргание.
CONFIRM = 2
#: Не поднимать тревогу по одному и тому же ключу чаще. Спасает от «мигалки»:
#: проверка, которая валится и чинится по кругу, даст одно сообщение в полчаса,
#: а не пятнадцать.
COOLDOWN_SECONDS = 30 * 60
#: Как часто напоминать о проблеме, которая никуда не делась.
REMIND_SECONDS = 6 * 60 * 60

#: Окно логов бота: сторожу хватает свежих, сутки ему перечитывать незачем.
BOT_WINDOW = "10m"


@dataclass
class Decision:
    """Что сторож решил сделать на этом тике."""
    state: dict
    text: str = ""          # пусто — молчим
    silent: bool = False    # отбой и напоминание уходят без звука


def _entry(state: dict, key: str) -> dict:
    return state.setdefault("checks", {}).setdefault(
        key, {"fails": 0, "oks": 0, "alerted": False, "last_alert": 0.0, "since": 0.0})


def _minutes(seconds: float) -> str:
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes} мин"
    hours, rest = divmod(minutes, 60)
    return f"{hours} ч {rest:02d} мин"


def decide(state: dict, checks: list[Check], now: float, *,
           confirm: int = CONFIRM, cooldown: float = COOLDOWN_SECONDS,
           remind: float = REMIND_SECONDS) -> Decision:
    """Обновить состояние по свежим проверкам и решить, писать ли человеку.

    Чистая: ничего не читает и не пишет, время получает аргументом. Всё, что
    сторож знает о прошлом, лежит в `state` и возвращается обновлённым.
    """
    state = json.loads(json.dumps(state)) if state else {}
    texts = {check.key: check.text for check in checks}

    fired: list[str] = []
    healed: list[str] = []
    for check in checks:
        entry = _entry(state, check.key)
        if check.urgent:
            entry["fails"] += 1
            entry["oks"] = 0
            if entry["fails"] == 1:
                entry["since"] = now
            # last_alert == 0 значит «ни разу не сообщали»: cooldown к первой
            # тревоге не применяется, иначе самая первая поломка молчала бы
            # ровно столько, сколько длится cooldown.
            rested = not entry["last_alert"] or now - entry["last_alert"] >= cooldown
            if not entry["alerted"] and entry["fails"] >= confirm and rested:
                entry["alerted"] = True
                entry["last_alert"] = now
                fired.append(check.key)
        else:
            entry["oks"] += 1
            entry["fails"] = 0
            if entry["alerted"] and entry["oks"] >= confirm:
                entry["alerted"] = False
                healed.append(check.key)

    alerted = [key for key, entry in state.setdefault("checks", {}).items()
               if entry["alerted"]]

    def lines(keys: list[str]) -> str:
        return "\n".join(f"🔴 {texts.get(key, key)}" for key in keys)

    if fired:
        state["last_remind"] = now
        head = "🔴 <b>Сервер: проблема</b>" if len(fired) == 1 else "🔴 <b>Сервер: проблемы</b>"
        body = lines(fired)
        others = [key for key in alerted if key not in fired]
        if others:
            body += "\n\nПродолжается:\n" + lines(others)
        return Decision(state, f"{head}\n\n{body}", silent=False)

    # Отбой даём только когда погасло ВСЁ: «одно из трёх починилось» — это не
    # новость, ради которой стоит писать, а половина сообщения ни о чём.
    if healed and not alerted:
        state["last_remind"] = 0.0
        return Decision(state, "🟢 <b>Сервер восстановился</b>\n\n"
                               + "\n".join(f"· {texts.get(key, key)}" for key in healed),
                        silent=True)

    if alerted and now - state.get("last_remind", 0.0) >= remind:
        state["last_remind"] = now
        since = min(state["checks"][key]["since"] for key in alerted)
        return Decision(state, f"🔴 <b>Всё ещё не работает</b> ({_minutes(now - since)})\n\n"
                               + lines(alerted), silent=True)

    return Decision(state)


def load_state(path: str = STATE_PATH) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def save_state(state: dict, path: str = STATE_PATH) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Через временный файл: сторож может быть убит на середине записи, а
    # обрезанный state.json означает «всё хорошо» и потерю тревоги.
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False)
    os.replace(tmp, path)


def paused(now: float, path: str = PAUSE_PATH) -> bool:
    try:
        with open(path, encoding="utf-8") as handle:
            return now < float(handle.read().strip())
    except (OSError, ValueError):
        return False


def main() -> int:
    now = time.time()
    if paused(now):
        return 0

    env = read_env()
    checks = collect(env, bot_window=BOT_WINDOW)
    decision = decide(load_state(), checks, now)
    save_state(decision.state)

    if not decision.text:
        return 0
    if send_telegram(env, decision.text, silent=decision.silent):
        return 0
    print("Telegram не принял тревогу", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
