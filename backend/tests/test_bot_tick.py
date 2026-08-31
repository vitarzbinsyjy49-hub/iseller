"""Фоновый тик сервиса `bot` (патч 1.1).

Тик делает работу, ради которой в проекте НЕ появился планировщик: разбирает
очередь уведомлений и сканирует брошенные корзины прямо в цикле long polling.
Отсюда главное требование: что бы ни случилось в фоне, приём сообщений
продолжается. Упавший тик = переставший отвечать бот.
"""
import inspect as inspect_module
import pytest

import app.scripts.bot_polling as bp


def test_tick_survives_any_background_failure(monkeypatch):
    """Любая ошибка фона гасится внутри тика.

    Если её выпустить, исключение поднимется в цикл polling — и уведомления
    сломают сам бот, то есть починка ухудшит систему сильнее, чем её отсутствие.
    """
    monkeypatch.setattr(bp, "_schema_ready", lambda state: True)

    def explode(*a, **kw):
        raise RuntimeError("БД недоступна")

    monkeypatch.setattr("app.db.session.SessionLocal", explode)
    bp._tick({"last_scan": 0.0})  # не должно поднять исключение


def test_tick_waits_for_schema_and_says_so_once(monkeypatch, caplog):
    """Деплой: бот стартует раньше, чем backend создаст таблицы.

    `depends_on` ждёт запуска контейнера, а не завершения его startup-события,
    поэтому окно существует на КАЖДОМ деплое со схемой. Ждём молча (одна строка
    в лог), а не вываливаем traceback, который приучает не читать логи бота.
    """
    class FakeInspector:
        def has_table(self, name):
            return False

    monkeypatch.setattr("sqlalchemy.inspect", lambda engine: FakeInspector())

    def must_not_run(*a, **kw):
        raise AssertionError("фоновая работа не должна идти до готовности схемы")

    monkeypatch.setattr("app.db.session.SessionLocal", must_not_run)

    state: dict = {}
    with caplog.at_level("INFO"):
        bp._tick(state)
        bp._tick(state)

    waiting = [r for r in caplog.records if "схема ещё не готова" in r.message]
    assert len(waiting) == 1, "предупреждение должно быть однократным, а не в каждом тике"
    assert not state.get("schema_ready")


def test_tick_runs_both_scans_and_drains(monkeypatch):
    """Тик — единственное место, откуда фоновые задачи вообще запускаются.

    Забыть подключить сюда новый скан = написать рабочий код, который никогда не
    вызывается: тесты сервиса при этом остаются зелёными.
    """
    monkeypatch.setattr(bp, "_schema_ready", lambda state: True)

    class FakeSession:
        def __enter__(self):
            return "db"

        def __exit__(self, *a):
            return False

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())

    called = []
    monkeypatch.setattr("app.services.cart_reminders.scan",
                        lambda db: called.append("carts") or {"queued": 0})
    monkeypatch.setattr("app.services.favorite_watch.scan",
                        lambda db: called.append("favorites"))
    monkeypatch.setattr("app.services.fx_rate.sync", lambda db: False)
    monkeypatch.setattr("app.services.notifications.drain",
                        lambda db, limit: called.append("drain") or
                        {"sent": 0, "failed": 0, "retry": 0})

    bp._tick({})
    assert called == ["carts", "favorites", "drain"]


def test_scans_do_not_run_on_every_tick(monkeypatch):
    """Опрос идёт каждые 30 секунд, сканы — раз в десятки минут.

    Иначе каждый тик — это полный проход по корзинам и избранному, то есть
    непрерывная нагрузка на базу ради данных, которые так часто не меняются.
    """
    monkeypatch.setattr(bp, "_schema_ready", lambda state: True)

    class FakeSession:
        def __enter__(self):
            return "db"

        def __exit__(self, *a):
            return False

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())

    scans = []
    monkeypatch.setattr("app.services.cart_reminders.scan",
                        lambda db: scans.append("carts") or {"queued": 0})
    monkeypatch.setattr("app.services.favorite_watch.scan",
                        lambda db: scans.append("favorites"))
    monkeypatch.setattr("app.services.notifications.drain",
                        lambda db, limit: {"sent": 0, "failed": 0, "retry": 0})

    state: dict = {}
    bp._tick(state)
    bp._tick(state)
    bp._tick(state)

    assert scans == ["carts", "favorites"], "скан повторился раньше своего интервала"


def _quiet_background(monkeypatch):
    """Фон без работы: тесты прогрева не должны зависеть от сканов и очереди."""
    monkeypatch.setattr(bp, "_schema_ready", lambda state: True)

    class FakeSession:
        def __enter__(self):
            return "db"

        def __exit__(self, *a):
            return False

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())
    monkeypatch.setattr("app.services.cart_reminders.scan", lambda db: {"queued": 0})
    monkeypatch.setattr("app.services.favorite_watch.scan", lambda db: {})
    monkeypatch.setattr("app.services.fx_rate.sync", lambda db: False)
    monkeypatch.setattr("app.services.notifications.drain",
                        lambda db, limit: {"sent": 0, "failed": 0, "retry": 0})


def test_gateway_warm_ping_runs_on_its_own_interval(monkeypatch):
    """Прогрев гейтвея идёт реже опроса и не чаще своего интервала.

    Холодный вызов функции на Vercel стоит ~6с ещё ДО обращения к модели, и
    платит их первый человек после простоя. Пинг в каждом тике (30с) — это уже
    не прогрев, а лишний трафик.
    """
    _quiet_background(monkeypatch)
    monkeypatch.setattr(bp.settings, "AI_PROVIDER", "anthropic")
    monkeypatch.setattr(bp.settings, "AI_ANTHROPIC_BASE_URL", "https://gw.example/api")
    monkeypatch.setattr(bp.settings, "AI_GATEWAY_WARM_MINUTES", 5)

    pings = []
    monkeypatch.setattr(bp.httpx, "get", lambda url, **kw: pings.append(url))

    state: dict = {}
    bp._tick(state)
    bp._tick(state)
    bp._tick(state)

    assert pings == ["https://gw.example/api/v1/messages"], "прогрев повторился раньше интервала"


def test_gateway_warm_ping_never_breaks_the_tick(monkeypatch):
    """Недоступный гейтвей не имеет права остановить уведомления.

    Прогрев — необязательная оптимизация. Если его ошибка утащит за собой
    drain, мы разменяем секунды ожидания на неотправленные сообщения.
    """
    _quiet_background(monkeypatch)
    monkeypatch.setattr(bp.settings, "AI_PROVIDER", "anthropic")
    monkeypatch.setattr(bp.settings, "AI_ANTHROPIC_BASE_URL", "https://gw.example/api")
    monkeypatch.setattr(bp.settings, "AI_GATEWAY_WARM_MINUTES", 5)

    drained = []
    monkeypatch.setattr("app.services.notifications.drain",
                        lambda db, limit: drained.append(1) or {"sent": 0, "failed": 0, "retry": 0})

    def unreachable(url, **kw):
        raise OSError("сеть недоступна")

    monkeypatch.setattr(bp.httpx, "get", unreachable)

    bp._tick({})
    assert drained == [1], "очередь уведомлений должна разбираться независимо от прогрева"


def test_no_warm_ping_without_anthropic_gateway(monkeypatch):
    """Без гейтвея греть нечего: fallback и Ollama живут не на Vercel."""
    _quiet_background(monkeypatch)
    monkeypatch.setattr(bp.settings, "AI_PROVIDER", "fallback")
    monkeypatch.setattr(bp.settings, "AI_ANTHROPIC_BASE_URL", "https://gw.example/api")
    monkeypatch.setattr(bp.settings, "AI_GATEWAY_WARM_MINUTES", 5)

    monkeypatch.setattr(bp.httpx, "get",
                        lambda url, **kw: pytest.fail("прогрев не нужен без гейтвея"))
    bp._tick({})


class FakeInspector:
    """Инспектор схемы: какие таблицы есть и какие у них колонки."""

    def __init__(self, tables: dict[str, list[str]]):
        self.tables = tables
        self.table_checks: list[str] = []

    def has_table(self, name):
        self.table_checks.append(name)
        return name in self.tables

    def get_columns(self, name):
        return [{"name": c} for c in self.tables[name]]


def _full_schema() -> dict[str, list[str]]:
    return {
        table: ["id", *columns] for table, columns in bp.REQUIRED_SCHEMA.items()
    }


def test_schema_check_stops_after_success(monkeypatch):
    """Схема не «разъезжается» обратно — проверять её в каждом тике незачем."""
    inspector = FakeInspector(_full_schema())
    monkeypatch.setattr("sqlalchemy.inspect", lambda engine: inspector)

    state: dict = {}
    assert bp._schema_ready(state) is True
    assert bp._schema_ready(state) is True
    assert inspector.table_checks == list(bp.REQUIRED_SCHEMA)


def test_schema_check_notices_a_missing_column(monkeypatch):
    """Таблица есть, а колонки ещё нет — это тоже «схема не готова».

    Колонки приезжают отдельными ALTER'ами уже после create_all, то есть ПОЗЖЕ
    своей таблицы. Проверка «таблица существует» пропускала такой момент, и
    скан падал на деплое с UndefinedColumn.
    """
    schema = _full_schema()
    schema["product_favorites"] = ["id", "user_id", "product_id"]  # без отметок
    monkeypatch.setattr("sqlalchemy.inspect", lambda engine: FakeInspector(schema))

    assert bp._schema_ready({}) is False


def test_failed_scan_retries_on_the_next_tick(monkeypatch):
    """Упавший скан не считается выполненным.

    Отметка времени двигалась ДО скана, поэтому падение (например, на ещё не
    добавленной колонке при деплое) откладывало повтор на целый интервал — час
    для избранного. Правильное поведение: повторить на следующем тике.
    """
    monkeypatch.setattr(bp, "_schema_ready", lambda state: True)

    class FakeSession:
        def __enter__(self):
            return "db"

        def __exit__(self, *a):
            return False

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())
    monkeypatch.setattr("app.services.notifications.drain",
                        lambda db, limit: {"sent": 0, "failed": 0, "retry": 0})
    monkeypatch.setattr("app.services.cart_reminders.scan",
                        lambda db: {"queued": 0})

    attempts = []

    def failing_scan(db):
        attempts.append(1)
        raise RuntimeError("колонки ещё нет")

    monkeypatch.setattr("app.services.favorite_watch.scan", failing_scan)

    state: dict = {}
    bp._tick(state)
    bp._tick(state)
    bp._tick(state)

    assert len(attempts) == 3, "скан должен повторяться, а не молчать до конца интервала"
    assert "last_favorite_scan" not in state


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
    monkeypatch.setattr("app.services.notifications.drain",
                        lambda db, limit: {"sent": 0, "failed": 0, "retry": 0})

    called = {}

    def fake_sync(db):
        called["db"] = db
        return True

    monkeypatch.setattr("app.services.fx_rate.sync", fake_sync)

    bp._tick({})

    assert called.get("db") == "db"


def test_fx_rate_sync_does_not_retry_within_five_minutes(monkeypatch):
    """Провал курса ЦБ РФ не должен бить блокирующим httpx.get на каждом тике.

    fx_rate.sync сам не идёт в сеть, если запись за сегодня уже есть — но в
    день, когда ЦБ недоступен, каждая попытка реально делает httpx.get(timeout=10)
    прямо перед getUpdates. Без гейта это до 10с простоя опроса апдейтов на
    каждый тик (≤30с) весь день. Порог — 5 минут МЕЖДУ ПОПЫТКАМИ (не только
    успехами): отметка должна двигаться и при неудаче."""
    monkeypatch.setattr(bp, "_schema_ready", lambda state: True)

    class FakeSession:
        def __enter__(self):
            return "db"

        def __exit__(self, *a):
            return False

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())
    monkeypatch.setattr("app.services.cart_reminders.scan", lambda db: {})
    monkeypatch.setattr("app.services.favorite_watch.scan", lambda db: {})
    monkeypatch.setattr("app.services.notifications.drain",
                        lambda db, limit: {"sent": 0, "failed": 0, "retry": 0})

    attempts = []
    monkeypatch.setattr("app.services.fx_rate.sync", lambda db: attempts.append(1) or False)

    state: dict = {}
    bp._tick(state)
    bp._tick(state)
    bp._tick(state)

    assert len(attempts) == 1, "повторная попытка раньше 5-минутного интервала"


def test_first_scan_runs_regardless_of_system_uptime(monkeypatch):
    """Первый скан после запуска не должен зависеть от аптайма машины.

    time.monotonic() отсчитывается от старта СИСТЕМЫ, поэтому «сейчас минус
    ноль» на свежезагруженном хосте меньше интервала — и сканы молча ждали бы
    30-60 минут. На проде с аптаймом в недели это не проявлялось, а на только
    что перезагруженной машине ломалось (и роняло эти тесты).
    """
    assert bp._due(None, 10.0, 1800) is True      # ни разу не сканировали
    assert bp._due(0.0, 10.0, 1800) is False      # сканировали в момент 0 — рано
    assert bp._due(5.0, 1805.0, 1800) is True     # интервал прошёл


def test_required_schema_covers_every_mini_migration_column():
    """Каждая колонка, добавленная мини-миграцией в таблицу из REQUIRED_SCHEMA,
    обязана быть в этом же REQUIRED_SCHEMA.

    Мини-миграция и список ожиданий бота — две половины одного решения, но
    лежат в разных файлах, и вторую забыть легко: так колонка
    users.acquisition_source приехала в `ALTER TABLE`, попала в ORM-модель (а
    значит и в SELECT скана корзин, который джойнит users) — и уронила бота
    полноэкранным UndefinedColumn на деплое, хотя механизм ожидания схемы был
    написан ровно против этого.
    """
    import re

    from app.main import _apply_demo_migrations

    source = inspect_module.getsource(_apply_demo_migrations)
    pattern = r"ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)"
    missed = [
        f"{table}.{column}"
        for table, column in re.findall(pattern, source)
        if table in bp.REQUIRED_SCHEMA and column not in bp.REQUIRED_SCHEMA[table]
    ]
    assert missed == [], (
        f"мини-миграция добавила {missed}, а бот этих колонок не ждёт — "
        f"на следующем деплое будет UndefinedColumn"
    )


def test_required_schema_waits_for_the_users_table():
    """Скан корзин джойнит users и тянет её колонки через ORM — новая колонка в
    users ломает бота так же, как своя собственная. Пока этой строки не было,
    деплой с users.acquisition_source дал трейсбек в логах бота."""
    assert "users" in bp.REQUIRED_SCHEMA
