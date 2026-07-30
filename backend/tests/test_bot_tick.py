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

    waiting = [r for r in caplog.records if "схема ещё не создана" in r.message]
    assert len(waiting) == 1, "предупреждение должно быть однократным, а не в каждом тике"
    assert not state.get("schema_ready")


def test_schema_check_stops_after_success(monkeypatch):
    """Таблица не исчезает — проверять её в каждом тике незачем."""
    checks = []

    class FakeInspector:
        def has_table(self, name):
            checks.append(name)
            return True

    monkeypatch.setattr("sqlalchemy.inspect", lambda engine: FakeInspector())

    state: dict = {}
    assert bp._schema_ready(state) is True
    assert bp._schema_ready(state) is True
    assert checks == ["notifications"]
