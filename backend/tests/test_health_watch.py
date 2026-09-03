"""Сторож здоровья сервера: логика «когда писать, когда молчать».

Проверяется только `decide()` — чистая функция из `deploy/health_watch.py`.
Сбор цифр (docker ps, curl, /proc/meminfo) тестировать нечего: там нет
решений, только чтение. А вот решение «писать или промолчать» — единственное,
что отделяет полезного сторожа от источника шума, который перестают читать.

`deploy/` живёт вне пакета `app` (скрипты запускаются на ХОСТЕ обычным
python3, без зависимостей проекта), поэтому путь добавляется руками.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy"))

from health_checks import Check  # noqa: E402
from health_watch import decide  # noqa: E402

MINUTE = 60.0


def ok(key: str = "api") -> Check:
    return Check(key, f"{key}: норма", bad=False, urgent=False)


def broken(key: str = "api") -> Check:
    return Check(key, f"{key}: не отвечает", bad=True, urgent=True)


def tick(state: dict, checks: list[Check], now: float, **kwargs):
    """Один проход сторожа: возвращает (новое состояние, текст сообщения)."""
    decision = decide(state, checks, now, **kwargs)
    return decision.state, decision.text


def test_single_failure_stays_silent():
    """Одна неудачная проверка — это моргание, а не авария.

    Ровно ради этого случая существует CONFIRM: перезапуск контейнера,
    таймаут curl'а и секундная просадка не должны доезжать до человека.
    """
    state, text = tick({}, [broken()], now=0.0)
    assert text == ""


def test_alert_after_confirmation():
    state, text = tick({}, [broken()], now=0.0)
    state, text = tick(state, [broken()], now=2 * MINUTE)
    assert "Сервер: проблема" in text
    assert "api: не отвечает" in text


def test_problem_is_reported_once():
    """Пока проблема жива, повторов нет — иначе это спам каждые две минуты."""
    state = {}
    for index in range(6):
        state, text = tick(state, [broken()], now=index * 2 * MINUTE)
        if index == 1:
            assert text, "тревога должна уйти на втором подтверждении"
        elif index > 1:
            assert text == "", f"повтор на тике {index}"


def test_recovery_message_then_silence():
    state = {}
    state, _ = tick(state, [broken()], now=0.0)
    state, _ = tick(state, [broken()], now=2 * MINUTE)

    state, text = tick(state, [ok()], now=4 * MINUTE)
    assert text == "", "отбой тоже требует подтверждения"
    state, text = tick(state, [ok()], now=6 * MINUTE)
    assert "восстановился" in text

    state, text = tick(state, [ok()], now=8 * MINUTE)
    assert text == ""


def test_flapping_check_does_not_spam():
    """Проверка, которая валится и чинится по кругу, не должна писать каждый раз.

    Без COOLDOWN мигающий API давал бы «упало / поднялось» каждые несколько
    минут — а это ровно тот шум, из-за которого уведомления перестают читать.
    """
    state = {}
    messages = []
    for index in range(30):
        # два тика плохо, два хорошо, и так по кругу
        check = broken() if (index // 2) % 2 == 0 else ok()
        state, text = tick(state, [check], now=index * 2 * MINUTE)
        if text:
            messages.append(text)
    alarms = [m for m in messages if "проблема" in m]
    assert len(alarms) <= 2, f"мигалка нашумела {len(alarms)} тревогами: {alarms}"


def test_reminder_while_still_broken():
    """Про проблему, о которой написали один раз ночью, легко забыть."""
    state = {}
    state, _ = tick(state, [broken()], now=0.0)
    state, _ = tick(state, [broken()], now=2 * MINUTE)

    state, text = tick(state, [broken()], now=3 * 3600)
    assert text == "", "через три часа напоминать рано"

    state, text = tick(state, [broken()], now=7 * 3600)
    assert "Всё ещё не работает" in text
    assert "7 ч" in text


def test_second_problem_is_reported_with_the_first():
    """Вторая поломка — новое сообщение, но с напоминанием, что первая жива."""
    state = {}
    state, _ = tick(state, [broken("api"), ok("warp")], now=0.0)
    state, text = tick(state, [broken("api"), ok("warp")], now=2 * MINUTE)
    assert "api" in text

    state, _ = tick(state, [broken("api"), broken("warp")], now=4 * MINUTE)
    state, text = tick(state, [broken("api"), broken("warp")], now=6 * MINUTE)
    assert "warp: не отвечает" in text
    assert "Продолжается" in text and "api: не отвечает" in text


def test_partial_recovery_is_silent():
    """«Одно из двух починилось» — не новость: отбой только когда погасло всё."""
    state = {}
    state, _ = tick(state, [broken("api"), broken("warp")], now=0.0)
    state, _ = tick(state, [broken("api"), broken("warp")], now=2 * MINUTE)

    state, text = tick(state, [ok("api"), broken("warp")], now=4 * MINUTE)
    state, text = tick(state, [ok("api"), broken("warp")], now=6 * MINUTE)
    assert text == ""

    state, _ = tick(state, [ok("api"), ok("warp")], now=8 * MINUTE)
    state, text = tick(state, [ok("api"), ok("warp")], now=10 * MINUTE)
    assert "восстановился" in text


def test_non_urgent_check_never_alerts():
    """Диск на 87% — строка в суточной сводке, но не повод писать немедленно."""
    disk = Check("disk", "диск 87% занято", bad=True, urgent=False)
    state = {}
    for index in range(5):
        state, text = tick(state, [disk], now=index * 2 * MINUTE)
        assert text == ""


def test_state_is_not_mutated_in_place():
    """decide() возвращает новое состояние, а не правит переданное.

    Сторож пишет state на диск ПОСЛЕ решения. Если бы decide() правил словарь
    по месту, неудачная отправка оставила бы на диске «уже сообщили» — и
    тревога пропала бы навсегда.
    """
    original = {}
    state, _ = tick(original, [broken()], now=0.0)
    assert original == {}
    assert state["checks"]["api"]["fails"] == 1
