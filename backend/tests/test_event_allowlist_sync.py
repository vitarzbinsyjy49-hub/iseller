"""Списки событий фронта и бэкенда не должны расходиться.

Они уже разошлись — молча и дважды. Фронт объявляет событие в типе `AppEvent`,
шлёт его в `POST /api/events`, backend не находит имя в `ALLOWED_EVENTS` и
отвечает 400. А `track()` во фронте — fire-and-forget с `.catch(() => {})`,
потому что аналитика не должна мешать пользователю. В сумме: событие не
доходит, ошибки никто не видит, и в отчёте «кнопкой не пользуются» вместо
«кнопку не посчитали».

К моменту написания теста так терялись пять событий: home_axis_switched,
search_mode_switched, product_shared, home_screen_prompted и ai_roadmap_opened.

Тест читает TypeScript глазами регулярного выражения — грубо, но достаточно:
объявление там строго одного вида (`| "имя_события"`), а любая попытка
усложнить его сломает тест, а не аналитику.
"""
import re
from pathlib import Path

import pytest

from app.schemas.ai import ALLOWED_EVENTS

ANALYTICS_TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "analytics.ts"


def frontend_events() -> set[str]:
    source = ANALYTICS_TS.read_text(encoding="utf-8")
    # Комментарии убираем ДО поиска границы union'а. Иначе точка с запятой
    # внутри пояснения («(source); текста запроса здесь нет») обрывает разбор
    # на середине списка — тест зеленеет, охраняя половину событий.
    source = re.sub(r"//[^\n]*", "", source)
    # Берём только union AppEvent: у ProductEventType своя ручка (/events/product)
    # и свой allowlist (EVENT_TYPES), их смешивать нельзя.
    block = re.search(r"export type AppEvent\s*=(.*?);", source, re.S)
    assert block, "не найден union AppEvent — изменился формат analytics.ts"
    return set(re.findall(r'"([a-z0-9_]+)"', block.group(1)))


@pytest.mark.skipif(not ANALYTICS_TS.exists(), reason="фронт не рядом (backend-only окружение)")
def test_backend_accepts_every_event_the_frontend_sends():
    missing = sorted(frontend_events() - ALLOWED_EVENTS)
    assert not missing, (
        "фронт шлёт события, которые backend отвергнет 400-м и которые поэтому "
        f"молча не попадут в аналитику: {missing}. Добавьте их в ALLOWED_EVENTS."
    )


@pytest.mark.skipif(not ANALYTICS_TS.exists(), reason="фронт не рядом (backend-only окружение)")
def test_frontend_union_is_parsed_at_all():
    """Страховка от «зелёного» теста на пустом множестве.

    Если формат analytics.ts изменится и разбор вернёт пустоту, предыдущий тест
    пройдёт всегда и перестанет что-либо охранять.
    """
    events = frontend_events()
    assert len(events) > 20, f"разобрано подозрительно мало событий: {events}"
    assert "cart_add" in events
