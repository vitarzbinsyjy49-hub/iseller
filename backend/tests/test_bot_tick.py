"""Фоновый тик сервиса `bot` (патч 1.1).

Тик делает работу, ради которой в проекте НЕ появился планировщик: разбирает
очередь уведомлений и сканирует брошенные корзины прямо в цикле long polling.
Отсюда главное требование: что бы ни случилось в фоне, приём сообщений
продолжается. Упавший тик = переставший отвечать бот.
"""
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
