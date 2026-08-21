# Курс доллара на главной + шторка «Курс и цены» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показать курс USD (ЦБ РФ) чипом на главной справа от тумблера «Категории/Бренды», с тапом в bottom-sheet, объясняющий влияние курса на цены, график за 30 дней, совет покупателю и FAQ.

**Architecture:** Новая таблица `fx_rate_history` (одна строка на календарный день — она же кэш текущего значения и источник истории для графика) наполняется фоновым тиком бота раз в день по образцу `_warm_gateway`. Backend отдаёт текущее значение через уже существующий `GET /api/config/public` и историю через новый `GET /api/fx/history`. Frontend — чип в стиле `SegmentedToggle` + переиспользуемый `SheetShell`.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (backend), React/TS + Vitest (frontend), `cbr-xml-daily.ru` как источник курса.

## Global Constraints

- Только USD, только курс ЦБ РФ — другие валюты/источники вне скопа.
- `usd_rate: null` (нет ни одной строки в истории) → чип НЕ рендерится. Никогда не показываем 0 или битое значение.
- Текст блоков «объяснение / совет / FAQ» в шторке — статичный копирайт на фронте, не через БД/админку.
- Новая таблица создаётся через `Base.metadata.create_all` (регистрация модели в `main.py`), миграция не нужна.
- `GET /api/fx/history` — без авторизации (не персональные данные).
- Формат чисел на фронте — `Intl.NumberFormat("ru-RU", ...)`.

---

## Task 1: Модель `FxRateHistory` и регистрация таблицы

**Files:**
- Create: `backend/app/models/fx_rate.py`
- Modify: `backend/app/main.py` (регистрация модели для `create_all`)
- Modify: `backend/tests/conftest.py` (регистрация модели для тестовой БД)

**Interfaces:**
- Produces: `FxRateHistory` — `id: int`, `date: date` (unique, index), `value: float` (₽ за $1), `fetched_at: datetime`.

- [ ] **Step 1: Создать модель**

```python
# backend/app/models/fx_rate.py
"""История курса USD (ЦБ РФ) — одна строка на календарный день.

Строка одновременно и «кэш» текущего значения (последняя по дате), и источник
истории для графика в шторке «Курс и цены» — отдельного in-memory TTL-кэша не
заводим, читаем таблицу напрямую. Наполняется фоновым тиком бота
(app/services/fx_rate.py::sync, вызывается из app/scripts/bot_polling.py).

Таблица создаётся через Base.metadata.create_all (новая таблица, ALTER не
нужен) — по аналогии с app/models/revoked_token.py.
"""
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Numeric, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class FxRateHistory(Base):
    __tablename__ = "fx_rate_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, unique=True, index=True)
    value: Mapped[float] = mapped_column(Numeric(10, 4))
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

- [ ] **Step 2: Зарегистрировать модель в `main.py`**

В `backend/app/main.py` рядом с остальными импортами моделей (строки 14-28), добавить после `_favorite`:

```python
from app.models import favorite as _favorite  # noqa: F401
from app.models import fx_rate as _fx_rate  # noqa: F401
```

- [ ] **Step 3: Зарегистрировать модель в тестовой БД**

В `backend/tests/conftest.py`, рядом с остальными импортами моделей (строки 26-36), добавить:

```python
from app.models.favorite import ProductFavorite  # noqa: F401 — регистрация таблицы
from app.models.fx_rate import FxRateHistory  # noqa: F401 — регистрация таблицы
```

- [ ] **Step 4: Проверить, что БД поднимается без ошибок**

Run: `cd backend && python -c "from app.main import app"`
Expected: без исключений (импорт `main.py` не падает).

- [ ] **Step 5: Commit**

```bash
git add backend/app/models/fx_rate.py backend/app/main.py backend/tests/conftest.py
git commit -m "feat(курс): модель FxRateHistory"
```

---

## Task 2: Сервис `services/fx_rate.py` — sync/latest/history

**Files:**
- Create: `backend/app/services/fx_rate.py`
- Test: `backend/tests/test_fx_rate.py`

**Interfaces:**
- Consumes: `FxRateHistory` (Task 1), `sqlalchemy.orm.Session`.
- Produces:
  - `sync(db: Session) -> bool` — True, если вставлена новая строка (для лога в bot_polling.py).
  - `latest(db: Session) -> dict | None` — `{"value": float, "delta": float}` или `None`, если строк нет.
  - `history(db: Session, days: int) -> list[dict]` — `[{"date": "YYYY-MM-DD", "value": float}, ...]` по возрастанию даты, не больше `days` строк.

- [ ] **Step 1: Написать падающие тесты**

```python
# backend/tests/test_fx_rate.py
"""Сервис курса USD: наполнение из ЦБ РФ + чтение для чипа/графика.

Правило нуль: без данных — None/[], никогда не 0 и не выдуманное значение
(см. docs/superpowers/specs/2026-08-20-usd-rate-widget-design.md).
"""
from datetime import date, timedelta

import httpx
import pytest

from app.models.fx_rate import FxRateHistory
from app.services import fx_rate


def _cbr_response(value: float, previous: float = 0.0) -> dict:
    return {"Valute": {"USD": {"Value": value, "Previous": previous}}}


def test_sync_inserts_row_when_missing(db, monkeypatch):
    monkeypatch.setattr(
        httpx, "get",
        lambda *a, **kw: httpx.Response(200, json=_cbr_response(91.23)),
    )
    inserted = fx_rate.sync(db)
    assert inserted is True
    row = db.query(FxRateHistory).one()
    assert row.date == date.today()
    assert float(row.value) == pytest.approx(91.23)


def test_sync_is_idempotent_for_same_day(db, monkeypatch):
    """Второй sync в тот же день не должен звать сеть и не должен дублировать строку."""
    calls = {"n": 0}

    def fake_get(*a, **kw):
        calls["n"] += 1
        return httpx.Response(200, json=_cbr_response(91.23))

    monkeypatch.setattr(httpx, "get", fake_get)
    fx_rate.sync(db)
    inserted_again = fx_rate.sync(db)

    assert inserted_again is False
    assert calls["n"] == 1, "второй sync не должен трогать сеть, если строка на сегодня уже есть"
    assert db.query(FxRateHistory).count() == 1


def test_sync_network_failure_does_not_raise(db, monkeypatch):
    def explode(*a, **kw):
        raise httpx.ConnectError("сеть недоступна")

    monkeypatch.setattr(httpx, "get", explode)
    inserted = fx_rate.sync(db)
    assert inserted is False
    assert db.query(FxRateHistory).count() == 0


def test_latest_returns_none_without_data(db):
    assert fx_rate.latest(db) is None


def test_latest_delta_is_zero_for_single_row(db):
    db.add(FxRateHistory(date=date.today(), value=91.23))
    db.commit()
    result = fx_rate.latest(db)
    assert result == {"value": pytest.approx(91.23), "delta": 0}


def test_latest_delta_against_previous_row(db):
    db.add(FxRateHistory(date=date.today() - timedelta(days=1), value=90.90))
    db.add(FxRateHistory(date=date.today(), value=91.23))
    db.commit()
    result = fx_rate.latest(db)
    assert result["value"] == pytest.approx(91.23)
    assert result["delta"] == pytest.approx(0.33, abs=1e-6)


def test_history_orders_ascending_and_respects_limit(db):
    base = date.today() - timedelta(days=5)
    for i in range(5):
        db.add(FxRateHistory(date=base + timedelta(days=i), value=90 + i))
    db.commit()

    rows = fx_rate.history(db, days=3)
    assert [r["date"] for r in rows] == [
        (base + timedelta(days=2)).isoformat(),
        (base + timedelta(days=3)).isoformat(),
        (base + timedelta(days=4)).isoformat(),
    ]
    assert rows[0]["value"] == pytest.approx(92)


def test_history_returns_fewer_rows_than_days_when_data_is_short(db):
    db.add(FxRateHistory(date=date.today(), value=91.23))
    db.commit()
    rows = fx_rate.history(db, days=30)
    assert len(rows) == 1
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd backend && python -m pytest tests/test_fx_rate.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.fx_rate'`

- [ ] **Step 3: Реализовать сервис**

```python
# backend/app/services/fx_rate.py
"""Курс USD (ЦБ РФ): наполнение истории + чтение для чипа/графика главной.

Одна строка в fx_rate_history на календарный день — это и кэш текущего
значения (последняя по дате строка), и источник для графика за N дней.
Отдельного in-memory TTL-кэша нет: таблица читается напрямую, дешёвый запрос.

sync() вызывается из фонового тика бота (app/scripts/bot_polling.py) на
каждом тике (≤30с), но реально бьёт по сети не чаще раза в день — идёт в
БД первым и решает по наличию строки на сегодня. Сетевая ошибка ловится
здесь же и не поднимается наружу (fail-soft, тот же принцип, что у
core/rate_limit.py и _warm_gateway).
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.fx_rate import FxRateHistory

logger = logging.getLogger("techshop.fx_rate")

CBR_DAILY_JSON_URL = "https://www.cbr-xml-daily.ru/daily_json.js"


def sync(db: Session) -> bool:
    """Вставляет строку за сегодня, если её ещё нет. True — вставили."""
    exists = db.execute(
        select(FxRateHistory.id).where(FxRateHistory.date == date.today())
    ).first()
    if exists is not None:
        return False

    try:
        resp = httpx.get(CBR_DAILY_JSON_URL, timeout=10)
        resp.raise_for_status()
        value = float(resp.json()["Valute"]["USD"]["Value"])
    except Exception:  # noqa: BLE001 — сеть/парсинг необязательны, отказ не событие
        logger.warning("не удалось получить курс ЦБ РФ", exc_info=True)
        return False

    db.add(FxRateHistory(date=date.today(), value=value))
    db.commit()
    return True


def latest(db: Session) -> dict | None:
    """{"value", "delta"} по последним двум строкам, None — если строк нет."""
    rows = db.execute(
        select(FxRateHistory).order_by(FxRateHistory.date.desc()).limit(2)
    ).scalars().all()
    if not rows:
        return None
    current = float(rows[0].value)
    previous = float(rows[1].value) if len(rows) > 1 else current
    return {"value": current, "delta": current - previous}


def history(db: Session, days: int) -> list[dict]:
    """Последние `days` строк по возрастанию даты: [{"date", "value"}, ...]."""
    cutoff = date.today() - timedelta(days=days)
    rows = db.execute(
        select(FxRateHistory)
        .where(FxRateHistory.date >= cutoff)
        .order_by(FxRateHistory.date.asc())
    ).scalars().all()
    return [{"date": r.date.isoformat(), "value": float(r.value)} for r in rows]
```

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `cd backend && python -m pytest tests/test_fx_rate.py -v`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/fx_rate.py backend/tests/test_fx_rate.py
git commit -m "feat(курс): сервис sync/latest/history для fx_rate_history"
```

---

## Task 3: Вызов `sync()` из фонового тика бота

**Files:**
- Modify: `backend/app/scripts/bot_polling.py`
- Modify: `backend/tests/test_bot_tick.py`

**Interfaces:**
- Consumes: `app.services.fx_rate.sync(db) -> bool` (Task 2).

- [ ] **Step 1: Написать падающий тест**

Добавить в `backend/tests/test_bot_tick.py`:

```python
def test_tick_calls_fx_rate_sync(monkeypatch):
    """Забыть подключить sync к тику — значит написать код, который никогда не
    вызывается: тесты сервиса (test_fx_rate.py) при этом остаются зелёными."""
    monkeypatch.setattr(bp, "_schema_ready", lambda state: True)

    class FakeSession:
        def __enter__(self):
            return "db"

        def __exit__(self, *a):
            return False

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())
    monkeypatch.setattr("app.services.cart_reminders.scan", lambda db: {})
    monkeypatch.setattr("app.services.favorite_watch.scan", lambda db: {})
    monkeypatch.setattr("app.services.notifications.drain", lambda db: None)

    called = {}

    def fake_sync(db):
        called["db"] = db
        return True

    monkeypatch.setattr("app.services.fx_rate.sync", fake_sync)

    bp._tick({})

    assert called.get("db") == "db"
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd backend && python -m pytest tests/test_bot_tick.py::test_tick_calls_fx_rate_sync -v`
Expected: FAIL — `called` остаётся пустым (sync ещё не вызывается из `_tick`).

- [ ] **Step 3: Добавить таблицу в `REQUIRED_SCHEMA` и вызов `sync` в `_tick`**

В `backend/app/scripts/bot_polling.py`, строка 62-66, добавить таблицу:

```python
REQUIRED_SCHEMA: dict[str, tuple[str, ...]] = {
    "notifications": (),
    "product_favorites": ("notified_price", "notified_in_stock"),
    "carts": (),
    "fx_rate_history": (),
}
```

В `_tick` (строки 161-165, импорты) добавить импорт сервиса:

```python
    from app.core.config import settings
    from app.db.session import SessionLocal
    from app.services import cart_reminders, favorite_watch, fx_rate
    from app.services.notifications import drain
```

И внутри `with SessionLocal() as db:` (после блока `favorite_watch`, перед концом `try`) добавить вызов — курс синкается КАЖДЫЙ тик (сам `sync()` решает, нужна ли сеть, отдельный `_due`-гейт не нужен, см. Task 2):

```python
            if fx_rate.sync(db):
                logger.info("курс ЦБ РФ обновлён")
```

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `cd backend && python -m pytest tests/test_bot_tick.py -v`
Expected: PASS, все тесты файла зелёные (не только новый — убедиться, что старые не сломались).

- [ ] **Step 5: Commit**

```bash
git add backend/app/scripts/bot_polling.py backend/tests/test_bot_tick.py
git commit -m "feat(курс): наполнение fx_rate_history из тика бота"
```

---

## Task 4: Публичные API — `usd_rate` в `/config/public` + `/api/fx/history`

**Files:**
- Modify: `backend/app/api/config.py`
- Create: `backend/app/api/fx.py`
- Modify: `backend/app/main.py` (регистрация роутера)
- Modify: `backend/tests/test_public_config.py`
- Test: `backend/tests/test_fx_history_route.py`

**Interfaces:**
- Consumes: `app.services.fx_rate.latest(db)`, `app.services.fx_rate.history(db, days)` (Task 2).
- Produces: `GET /api/config/public` → поле `usd_rate: {"value": float, "delta": float} | None`; `GET /api/fx/history?days=N` → `{"history": [{"date", "value"}, ...]}`.

- [ ] **Step 1: Написать падающие тесты**

`public_config()` в этой задаче начинает делать реальный DB-запрос
(`fx_rate.latest(db)`), а существующая фикстура `client` в
`backend/tests/test_public_config.py` (строки 26-32) отдаёт голый
`TestClient(app)` без переопределения `get_db` — до сих пор это было
нормально, эндпоинт вообще не трогал БД. Теперь так нельзя: startup-событие
(которое вызывает `create_all` и создаёт таблицы) не выполняется для
`TestClient(app)` без `with` (см. docstring `test_api_routes.py`), и запрос
к ещё не созданной `fx_rate_history` упадёт ошибкой БД у **любого**
теста файла, не только новых. Поэтому фикстуру нужно завести на
`db`-фикстуру (как уже сделано в `test_api_routes.py`), а не только
добавить новые тесты.

Заменить существующую фикстуру (строки 26-32) на:

```python
from app.db.session import get_db


@pytest.fixture()
def client(monkeypatch, db):
    for name, value in SECRETS.items():
        monkeypatch.setattr(settings, name, value, raising=False)
    monkeypatch.setattr(settings, "BOT_USERNAME", "isellerAIbot", raising=False)
    monkeypatch.setattr(settings, "MANAGER_RETAIL_URL", "https://t.me/manager", raising=False)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
```

(добавить импорт `from app.db.session import get_db` к существующим
импортам вверху файла; остальные существующие тесты файла НЕ трогать —
они получат рабочую БД автоматически через ту же фикстуру и должны
остаться зелёными без единой правки в их коде)

Добавить в конец `backend/tests/test_public_config.py`:

```python
from datetime import date

from app.models.fx_rate import FxRateHistory


def test_public_config_usd_rate_is_null_without_data(client):
    data = client.get("/api/config/public").json()
    assert data["usd_rate"] is None


def test_public_config_usd_rate_with_data(client, db):
    db.add(FxRateHistory(date=date.today(), value=91.23))
    db.commit()
    data = client.get("/api/config/public").json()
    assert data["usd_rate"] == {"value": 91.23, "delta": 0}
```

Создать `backend/tests/test_fx_history_route.py`:

```python
"""GET /api/fx/history — без авторизации, отдаёт историю курса для графика в шторке."""
from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.db.session import get_db
from app.main import app
from app.models.fx_rate import FxRateHistory


def _client(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    return TestClient(app)


def test_history_route_empty_without_data(db):
    client = _client(db)
    try:
        r = client.get("/api/fx/history?days=30")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200
    assert r.json() == {"history": []}


def test_history_route_respects_days_param(db):
    base = date.today() - timedelta(days=5)
    for i in range(5):
        db.add(FxRateHistory(date=base + timedelta(days=i), value=90 + i))
    db.commit()

    client = _client(db)
    try:
        r = client.get("/api/fx/history?days=2")
    finally:
        app.dependency_overrides.clear()

    body = r.json()["history"]
    assert len(body) == 2
    assert body[-1]["value"] == 94


def test_history_route_requires_no_auth(db):
    """Публичный рыночный курс — без токена всё равно 200, а не 401."""
    client = _client(db)
    try:
        r = client.get("/api/fx/history?days=30")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd backend && python -m pytest tests/test_public_config.py tests/test_fx_history_route.py -v`
Expected: FAIL — `usd_rate` нет в ответе `/config/public`; `/api/fx/history` — 404 (роутера ещё нет).

- [ ] **Step 3: Добавить `usd_rate` в `/config/public`**

В `backend/app/api/config.py`:

```python
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.services import fx_rate
```

(заменить существующую строку `from fastapi import APIRouter` и добавить остальные импорты после неё)

```python
@router.get("/public")
def public_config(db: Session = Depends(get_db)):
    retail = settings.MANAGER_RETAIL_URL.strip()
    return {
        "app_name": settings.APP_NAME,
        "manager_retail_url": retail,
        "manager_wholesale_url": settings.MANAGER_WHOLESALE_URL.strip() or retail,
        "manager_b2b_url": settings.MANAGER_B2B_URL.strip() or retail,
        "manager_tradein_url": settings.MANAGER_TRADEIN_URL.strip() or retail,
        "telegram_channel_url": settings.TELEGRAM_CHANNEL_URL.strip(),
        "mini_app_url": settings.MINI_APP_URL.strip(),
        "shop_phone": settings.SHOP_PHONE.strip(),
        "bot_username": settings.BOT_USERNAME.strip().lstrip("@"),
        "ai_vendor": ai_vendor(),
        "ai_model": settings.AI_ANTHROPIC_MODEL.strip() if ai_vendor() else "",
        # None, если строк в fx_rate_history ещё нет — фронт в этом случае не
        # рисует чип вовсе, а не показывает 0 или битое значение.
        "usd_rate": fx_rate.latest(db),
    }
```

(остальные строки функции — `retail = ...` и docstring-комментарий про менеджеров — остаются как есть, меняются только сигнатура и добавленное поле)

- [ ] **Step 4: Создать роутер `/api/fx/history`**

```python
# backend/app/api/fx.py
"""GET /api/fx/history — история курса USD для графика в шторке «Курс и цены».

Без авторизации: обычный рыночный курс, не персональные данные. Дёргается
фронтом лениво (только при открытии шторки), поэтому отдельный от
/config/public эндпоинт — не грузим историю на каждой загрузке главной.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services import fx_rate

router = APIRouter(prefix="/fx", tags=["fx"])


@router.get("/history")
def get_history(
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
):
    return {"history": fx_rate.history(db, days)}
```

В `backend/app/main.py`, рядом с другими `app.include_router(...)` (после строки со `health.router`), добавить:

```python
from app.api import fx as fx_router  # рядом с остальными импортами роутеров вверху файла
...
app.include_router(fx_router.router, prefix="/api")
```

(найти существующий блок `app.include_router(health.router, prefix="/api")` и соседние — добавить строку в том же стиле, порядок роутеров не важен)

- [ ] **Step 5: Запустить тесты и убедиться, что они проходят**

Run: `cd backend && python -m pytest tests/test_public_config.py tests/test_fx_history_route.py -v`
Expected: PASS

- [ ] **Step 6: Прогнать весь backend-набор**

Run: `cd backend && python -m pytest -q`
Expected: все тесты зелёные (не только новые — проверить регрессии в остальных 774+ тестах).

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/config.py backend/app/api/fx.py backend/app/main.py backend/tests/test_public_config.py backend/tests/test_fx_history_route.py
git commit -m "feat(курс): usd_rate в /config/public + GET /api/fx/history"
```

---

## Task 5: `lib/sparkline.ts` — точки для мини-графика

**Files:**
- Create: `frontend/src/lib/sparkline.ts`
- Test: `frontend/src/lib/sparkline.test.ts`

**Interfaces:**
- Produces: `toSparklinePoints(values: number[], width: number, height: number) -> string` — строка `points` для SVG `<polyline>`.

- [ ] **Step 1: Написать падающие тесты**

```typescript
// frontend/src/lib/sparkline.test.ts
import { describe, expect, it } from "vitest";
import { toSparklinePoints } from "./sparkline";

describe("toSparklinePoints", () => {
  it("пустой массив — пустая строка точек", () => {
    expect(toSparklinePoints([], 320, 80)).toBe("");
  });

  it("одна точка — не падает, ставит точку по центру высоты", () => {
    const points = toSparklinePoints([91.23], 320, 80);
    expect(points).toBe("0,40");
  });

  it("минимум и максимум упираются в края высоты (с учётом инверсии Y)", () => {
    const points = toSparklinePoints([90, 92], 100, 80);
    const [[, y1], [, y2]] = points.split(" ").map((p) => p.split(",").map(Number));
    // SVG Y растёт вниз: меньшее значение (90) — внизу (y больше), большее (92) — вверху.
    expect(y1).toBeGreaterThan(y2);
    expect(Math.min(y1, y2)).toBeCloseTo(0, 5);
    expect(Math.max(y1, y2)).toBeCloseTo(80, 5);
  });

  it("равные значения — не делит на ноль, рисует плоскую линию по центру", () => {
    const points = toSparklinePoints([91, 91, 91], 100, 80);
    const ys = points.split(" ").map((p) => Number(p.split(",")[1]));
    expect(ys.every((y) => y === 40)).toBe(true);
  });

  it("X растягивается по всей ширине от 0 до width", () => {
    const points = toSparklinePoints([1, 2, 3, 4], 300, 80);
    const xs = points.split(" ").map((p) => Number(p.split(",")[0]));
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(300);
  });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd frontend && npx vitest run src/lib/sparkline.test.ts`
Expected: FAIL — модуль `./sparkline` не найден.

- [ ] **Step 3: Реализовать**

```typescript
// frontend/src/lib/sparkline.ts
/** Точки для SVG <polyline> мини-графика курса (шторка «Курс и цены»).
 *
 *  Чистая функция без DOM — тестируется изолированно, как scrollPositionAt/
 *  easeOutQuint в lib/motion.ts. SVG Y растёт вниз, поэтому большее значение
 *  курса даёт МЕНЬШИЙ y (выше на экране) — учтено ниже.
 */
export function toSparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `0,${height / 2}`;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = width / (values.length - 1);

  return values
    .map((v, i) => {
      const x = i * step;
      // span === 0 (все значения равны) — плоская линия по центру, деления на ноль нет.
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${x},${y}`;
    })
    .join(" ");
}
```

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `cd frontend && npx vitest run src/lib/sparkline.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/sparkline.ts frontend/src/lib/sparkline.test.ts
git commit -m "feat(курс): toSparklinePoints для мини-графика"
```

---

## Task 6: `usd_rate` в типе `PublicConfig`

**Files:**
- Modify: `frontend/src/lib/appConfig.ts`

**Interfaces:**
- Produces: `PublicConfig.usd_rate: { value: number; delta: number } | null`.

- [ ] **Step 1: Добавить поле в тип и в `EMPTY`**

```typescript
export type PublicConfig = {
  app_name: string;
  manager_retail_url: string;
  manager_wholesale_url: string;
  manager_b2b_url: string;
  manager_tradein_url: string;
  telegram_channel_url: string;
  mini_app_url: string;
  shop_phone: string;
  bot_username: string;
  ai_vendor: string;
  ai_model: string;
  /** Курс USD ЦБ РФ на сегодня + дельта к предыдущему дню. null — данных ещё
   *  нет (холодный старт до первого успешного sync у бота) — не рисуем чип. */
  usd_rate: { value: number; delta: number } | null;
};

const EMPTY: PublicConfig = {
  app_name: "AI Seller",
  manager_retail_url: "", manager_wholesale_url: "",
  manager_b2b_url: "", manager_tradein_url: "",
  telegram_channel_url: "", mini_app_url: "", bot_username: "", shop_phone: "",
  ai_vendor: "", ai_model: "",
  usd_rate: null,
};
```

- [ ] **Step 2: Проверить типы**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок (поле опционально совместимо с существующим `{ ...c }` merge в `fetchPublicConfig`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/appConfig.ts
git commit -m "feat(курс): usd_rate в типе PublicConfig"
```

---

## Task 7: `lib/fxFormat.ts` + компонент `FxRateChip`

В проекте нет ни одного `.test.tsx` и не установлен `@testing-library/react`/
`jsdom` (`vitest.config.ts` жёстко на `environment: "node"`) — компоненты
проверяются вручную в браузере (см. `components/onboarding/*.tsx` — там тоже
нет тестов на сам компонент, только на чистую логику в `lib/`). Эта задача
следует тому же паттерну: форматирование и выбор цвета/стрелки — чистая
функция в `lib/`, тестируемая без DOM; сам компонент — тонкая обёртка над ней,
без отдельного теста (проверяется вручную в Task 9, Step 5).

**Files:**
- Create: `frontend/src/lib/fxFormat.ts`
- Test: `frontend/src/lib/fxFormat.test.ts`
- Create: `frontend/src/components/FxRateChip.tsx`

**Interfaces:**
- Consumes: `PublicConfig["usd_rate"]` (Task 6).
- Produces: `formatFxChip(usdRate) -> { value: string; delta: string; rising: boolean } | null`; `<FxRateChip usdRate={...} onClick={...} />` — `null`, если `usdRate === null`.

- [ ] **Step 1: Написать падающие тесты на чистую функцию**

```typescript
// frontend/src/lib/fxFormat.test.ts
import { describe, expect, it } from "vitest";
import { formatFxChip } from "./fxFormat";

describe("formatFxChip", () => {
  it("null при usdRate === null — чипу нечего рисовать", () => {
    expect(formatFxChip(null)).toBeNull();
  });

  it("значение — один знак после запятой, дельта — модуль", () => {
    const result = formatFxChip({ value: 91.23, delta: 0.34 });
    expect(result?.value).toBe("91,2");
    expect(result?.delta).toBe("0,3");
  });

  it("растущий курс — rising: true", () => {
    expect(formatFxChip({ value: 91.23, delta: 0.34 })?.rising).toBe(true);
  });

  it("падающий курс — rising: false, дельта всё равно положительная строка", () => {
    const result = formatFxChip({ value: 91.23, delta: -0.5 });
    expect(result?.rising).toBe(false);
    expect(result?.delta).toBe("0,5");
  });

  it("нулевая дельта — rising: true (не «падает»)", () => {
    expect(formatFxChip({ value: 91.23, delta: 0 })?.rising).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd frontend && npx vitest run src/lib/fxFormat.test.ts`
Expected: FAIL — модуль `./fxFormat` не найден.

- [ ] **Step 3: Реализовать чистую функцию**

```typescript
// frontend/src/lib/fxFormat.ts
/** Форматирование курса USD для чипа/шторки главной (см. lib/appConfig.ts —
 *  PublicConfig["usd_rate"]). Чистая функция, без DOM — тестируется
 *  изолированно, как остальная логика в этом каталоге (motion.ts, sparkline.ts). */
const FORMAT = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatFxChip(
  usdRate: { value: number; delta: number } | null,
): { value: string; delta: string; rising: boolean } | null {
  if (usdRate === null) return null;
  return {
    value: FORMAT.format(usdRate.value),
    delta: FORMAT.format(Math.abs(usdRate.delta)),
    rising: usdRate.delta >= 0,
  };
}
```

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `cd frontend && npx vitest run src/lib/fxFormat.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 5: Реализовать компонент**

```tsx
// frontend/src/components/FxRateChip.tsx
/** Курс USD на главной — пилюля в стиле SegmentedToggle, справа от тумблера
 *  «Категории/Бренды» (Home.tsx). Тап открывает FxRateSheet.
 *
 *  Форматирование — в lib/fxFormat.ts (тестируется отдельно, без DOM); здесь
 *  только JSX. null от formatFxChip означает «строк в fx_rate_history ещё
 *  нет» — рисуем ничего, а не 0/битый вид (см. спеку). */
import { formatFxChip } from "../lib/fxFormat";

export function FxRateChip({
  usdRate,
  onClick,
}: {
  usdRate: { value: number; delta: number } | null;
  onClick: () => void;
}) {
  const formatted = formatFxChip(usdRate);
  if (formatted === null) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="tap flex h-9 shrink-0 items-center gap-1 rounded-full bg-white/[0.13] px-3 text-[12.5px] font-bold text-[color:var(--app-hero-chip-ink)] outline-none ring-1 ring-inset ring-white/15 focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <span>${formatted.value}</span>
      <span className={formatted.rising ? "text-green" : "text-danger"}>
        {formatted.rising ? "▲" : "▼"}{formatted.delta}
      </span>
    </button>
  );
}
```

- [ ] **Step 6: Проверить типы**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/fxFormat.ts frontend/src/lib/fxFormat.test.ts frontend/src/components/FxRateChip.tsx
git commit -m "feat(курс): чип FxRateChip + lib/fxFormat"
```

---

## Task 8: Компонент `FxRateSheet`

Как и в Task 7 — в проекте нет инфраструктуры для рендер-тестов компонентов
(нет `.test.tsx`, не установлен `@testing-library/react`/`jsdom`). «Ленивость»
загрузки истории (грузим только при открытии, не на каждой загрузке главной)
здесь гарантирована СТРУКТУРНО, не поведением компонента: `FxRateSheet`
монтируется в DOM только когда `fxSheetOpen === true` (см. Task 9, условный
рендер в `Home.tsx`) — значит `useEffect` внутри физически не может
выполниться раньше открытия шторки, это следует из семантики React-маунта, а
не из логики самого компонента. Отдельного теста на это не пишем — проверяем
глазами в браузере (Task 9, Step 5): открыть шторку и убедиться, что запрос к
`/api/fx/history` появляется в Network только в момент тапа по чипу.

**Files:**
- Create: `frontend/src/components/FxRateSheet.tsx`

**Interfaces:**
- Consumes: `SheetShell` из `components/ScenarioSheet.tsx` (существует), `toSparklinePoints` (Task 5), `api<T>()` из `lib/api.ts` (существует), `PublicConfig["usd_rate"]` (Task 6).
- Produces: `<FxRateSheet usdRate={...} onClose={...} />`.

- [ ] **Step 1: Реализовать компонент**

```tsx
// frontend/src/components/FxRateSheet.tsx
/** Шторка «Курс и цены» — открывается тапом по FxRateChip на главной.
 *
 *  Текущее значение/дельта приходят пропом (уже есть из /config/public,
 *  повторно не грузим). История для графика — лениво при открытии, не на
 *  каждой загрузке главной (см. спеку, GET /api/fx/history?days=30).
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toSparklinePoints } from "../lib/sparkline";
import { SheetShell } from "./ScenarioSheet";

const FORMAT = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HISTORY_DAYS = 30;

type HistoryPoint = { date: string; value: number };

const FAQ: { q: string; a: string }[] = [
  {
    q: "Цены меняются каждый день вслед за курсом?",
    a: "Нет — мы пересматриваем цены при заметных движениях курса, не ежедневно.",
  },
  {
    q: "Курс вырос — моя оформленная заявка подорожает?",
    a: "Нет, цена фиксируется в момент оформления заявки.",
  },
  {
    q: "Откуда берётся курс?",
    a: "Официальный курс ЦБ РФ, обновляется раз в сутки.",
  },
];

export default function FxRateSheet({
  usdRate,
  onClose,
}: {
  usdRate: { value: number; delta: number };
  onClose: () => void;
}) {
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ history: HistoryPoint[] }>(`/fx/history?days=${HISTORY_DAYS}`)
      .then((data) => { if (!cancelled) setHistory(data.history); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, []);

  const rising = usdRate.delta >= 0;
  const points = history ? toSparklinePoints(history.map((h) => h.value), 300, 70) : "";

  return (
    <SheetShell onClose={onClose} labelledBy="fx-rate-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start justify-between px-5 pb-2 pt-4">
            <div>
              <h2 id="fx-rate-title" className="text-[30px] font-extrabold tracking-[-0.02em] text-text">
                {FORMAT.format(usdRate.value)}&nbsp;₽
              </h2>
              <p className={`mt-0.5 text-[13px] font-bold ${rising ? "text-green" : "text-danger"}`}>
                {rising ? "▲" : "▼"} {FORMAT.format(Math.abs(usdRate.delta))} за сутки
              </p>
            </div>
            <button
              onClick={() => close()}
              aria-label="Закрыть"
              className="tap flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mutedbg"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <p className="px-5 text-[12px] text-muted">Курс ЦБ РФ · обновляется ежедневно</p>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
            <div>
              <h4 className="text-[13px] font-bold uppercase tracking-[0.04em] text-muted">
                Почему это влияет на цены
              </h4>
              <p className="mt-2 text-[14px] leading-[1.5] text-text">
                Часть техники — iPhone, MacBook, PlayStation — мы везём из Кореи и
                Гонконга за доллары. Когда курс растёт, закупка дорожает, и цена на
                складе может измениться. Мы стараемся не менять её каждый день, но
                заметный скачок курса обычно виден и в цене.
              </p>
            </div>

            <div className="mt-5">
              <h4 className="text-[13px] font-bold uppercase tracking-[0.04em] text-muted">
                Курс за {HISTORY_DAYS} дней
              </h4>
              <div className="mt-2 rounded-xl2 border border-border p-3.5">
                {history === null ? (
                  <div className="skeleton h-[70px] w-full rounded-lg" />
                ) : history.length < 2 ? (
                  <p className="text-[13px] text-muted">Пока недостаточно данных для графика.</p>
                ) : (
                  <svg viewBox="0 0 300 70" width="100%" height="70">
                    <polyline
                      fill="none" stroke="rgb(var(--app-accent))" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round" points={points}
                    />
                  </svg>
                )}
                {history !== null && history.length > 0 && history.length < HISTORY_DAYS && (
                  <p className="mt-2 text-[12px] text-muted">
                    Копим историю с запуска — график будет за полный месяц позже.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-5 flex gap-2.5 rounded-xl2 bg-mutedbg p-3.5">
              <span className="text-[18px]">💡</span>
              <p className="text-[14px] leading-[1.45] text-text">
                Если планируете покупку — цена на складе фиксируется в момент
                оформления заявки, а не пересчитывается каждый день. Не нужно ловить
                «удачный курс».
              </p>
            </div>

            <div className="mt-5">
              <h4 className="text-[13px] font-bold uppercase tracking-[0.04em] text-muted">
                Частые вопросы
              </h4>
              {FAQ.map((item, i) => (
                <div key={item.q} className={`py-3 ${i > 0 ? "border-t border-border" : ""}`}>
                  <p className="text-[14px] font-semibold text-text">{item.q}</p>
                  <p className="mt-1 text-[13.5px] leading-[1.45] text-muted">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </SheetShell>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/FxRateSheet.tsx
git commit -m "feat(курс): шторка FxRateSheet"
```

---

## Task 9: Вписать чип и шторку в `Home.tsx`

**Files:**
- Modify: `frontend/src/pages/Home.tsx`

**Interfaces:**
- Consumes: `FxRateChip` (Task 7), `FxRateSheet` (Task 8), `config.usd_rate` (уже доступен через существующий `usePublicConfig()`, строка 192).

- [ ] **Step 1: Добавить импорты**

В начало `frontend/src/pages/Home.tsx`, рядом с другими импортами компонентов:

```typescript
import { FxRateChip } from "../components/FxRateChip";
import FxRateSheet from "../components/FxRateSheet";
```

- [ ] **Step 2: Добавить состояние открытия шторки**

Рядом с другими `useState` в компоненте `Home` (около строки 231, где объявлены `beta`/`about`):

```typescript
const [fxSheetOpen, setFxSheetOpen] = useState(false);
```

- [ ] **Step 3: Вписать чип в строку тумблера (строки 450-463)**

Заменить:

```tsx
        {/* Ось навигации: категории или бренды. Тумблера нет, пока бренды не
            пришли — переключатель в пустую вкладку хуже отсутствующего. */}
        {hasBrandAxis && (
          <div className="mt-3 flex items-center">
            <SegmentedToggle
              value={axis}
              onChange={switchAxis}
              options={[
                { value: "category", label: "Категории" },
                { value: "brand", label: "Бренды" },
              ] as const}
              ariaLabel="Навигация по каталогу"
              variant="on-dark"
            />
          </div>
        )}
```

на:

```tsx
        {/* Ось навигации (категории/бренды) слева, курс USD справа. Строка
            рисуется, если есть ХОТЯ БЫ ОДНО из двух — тумблера нет, пока
            бренды не пришли, чип нет, пока в fx_rate_history нет строк. */}
        {(hasBrandAxis || config.usd_rate) && (
          <div className="mt-3 flex items-center justify-between">
            {hasBrandAxis ? (
              <SegmentedToggle
                value={axis}
                onChange={switchAxis}
                options={[
                  { value: "category", label: "Категории" },
                  { value: "brand", label: "Бренды" },
                ] as const}
                ariaLabel="Навигация по каталогу"
                variant="on-dark"
              />
            ) : <div />}
            <FxRateChip usdRate={config.usd_rate} onClick={() => setFxSheetOpen(true)} />
          </div>
        )}

        {fxSheetOpen && config.usd_rate && (
          <FxRateSheet usdRate={config.usd_rate} onClose={() => setFxSheetOpen(false)} />
        )}
```

- [ ] **Step 4: Проверить типы, тесты, сборку**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: всё зелёное, сборка проходит.

- [ ] **Step 5: Проверить вручную в браузере**

1. Убедиться, что backend/bot локально подняты (`docker compose -f docker-compose.demo.yml ps`), перезапустить frontend-контейнер (`docker compose -f docker-compose.demo.yml restart frontend` — bind-mount без inotify).
2. Открыть `http://localhost:5173`, убедиться, что чип на главной не появляется, пока в `fx_rate_history` нет строк (ожидаемо на свежем стенде).
3. Вставить тестовую строку в локальную БД (например через `docker compose -f docker-compose.demo.yml exec backend python -c "from app.db.session import SessionLocal; from app.models.fx_rate import FxRateHistory; from datetime import date; db=SessionLocal(); db.add(FxRateHistory(date=date.today(), value=91.23)); db.commit()"`), обновить главную — чип должен появиться.
4. Открыть вкладку Network в devtools ДО тапа по чипу — убедиться, что запроса к `/api/fx/history` ещё нет. Тапнуть по чипу — шторка должна открыться, показать курс, график (короткий, с подписью «копим историю»), совет, FAQ, и ровно в этот момент в Network должен появиться запрос к `/api/fx/history?days=30` (не раньше — это и есть проверка «ленивости» вместо автотеста, см. Task 8). Закрыть шторку крестиком.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Home.tsx
git commit -m "feat(курс): чип и шторка на главной"
```

---

## Task 10: Финальная проверка всего стека

**Files:** нет новых, только проверка.

- [ ] **Step 1: Backend — полный набор тестов**

Run: `cd backend && python -m pytest -q`
Expected: все тесты зелёные.

- [ ] **Step 2: Frontend — типы, тесты, сборка**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: всё зелёное.

- [ ] **Step 3: Admin — типы и сборка (курс туда не заходит, но по чеклисту проекта проверяется всегда)**

Run: `cd admin && npx tsc --noEmit && npm run build`
Expected: без ошибок (регрессий быть не должно — admin не тронут).

- [ ] **Step 4: Финальный commit, если остались незакоммиченные правки**

```bash
git status --short
```

Если есть незакоммиченное — закоммитить с понятным сообщением по тому же файлу/теме.
