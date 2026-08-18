"""Outbox уведомлений: очередь, отправка, тексты (патч 1.1).

Главные требования, которые здесь закреплены:
  - смена статуса заявки ставит РОВНО ОДНО уведомление, повтор не удваивает;
  - падение Telegram не ломает смену статуса и не теряет уведомление;
  - постоянная ошибка (бот заблокирован) не крутится в очереди вечно;
  - в HTTP-запросе админки сети нет — уведомление только ставится в очередь.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.lead import Lead
from app.models.notification import MAX_ATTEMPTS, Notification
from app.models.user import User
from app.services.notification_templates import (
    favorite_message,
    Message,
    cart_reminder_message,
    format_money,
    lead_cancelled_by_user_message,
    lead_status_message,
    new_lead_message,
    plural_items,
)
from app.services.notifications import drain, enqueue
from app.services.telegram_publisher import TelegramPublishError, TelegramRateLimited


@pytest.fixture()
def ctx(db, monkeypatch):
    # Без токена бота уведомления намеренно не ставятся в очередь вовсе (см.
    # notifications_enabled): очередь не должна копить то, что никогда не уйдёт.
    # В тестах интеграции токен нужен — сеть при этом всё равно не трогается.
    monkeypatch.setattr("app.core.config.settings.TELEGRAM_BOT_TOKEN", "test-token")
    user = User(telegram_id=777, first_name="Гарик", username="garik")
    db.add(user)
    db.commit()
    db.refresh(user)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, user
    finally:
        app.dependency_overrides.clear()


def make_lead(db, **kw) -> Lead:
    defaults = dict(telegram_id=777, name="Гарик", status="new", source="home",
                    product_title="iPhone 17 Pro", items_count=0)
    defaults.update(kw)
    lead = Lead(**defaults)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def pending(db) -> list[Notification]:
    return db.query(Notification).order_by(Notification.id).all()


# ============================ Тексты (без сети и БД) ============================
def test_plural_items_covers_russian_forms():
    assert plural_items(1) == "1 товар"
    assert plural_items(3) == "3 товара"
    assert plural_items(5) == "5 товаров"
    # 11-14 — исключение из общего правила: «11 товаров», а не «11 товар».
    assert plural_items(11) == "11 товаров"
    assert plural_items(21) == "21 товар"


def test_format_money_matches_storefront():
    assert format_money(94000) == "94 000 ₽"
    assert format_money(None) == ""


def test_new_status_is_silent():
    """Заявку только что создал сам человек — он видел экран успеха."""
    assert lead_status_message(status="new", public_number="№1") is None


def test_unknown_status_is_silent():
    assert lead_status_message(status="whatever", public_number="№1") is None


def test_cart_lead_status_message_uses_items_and_total():
    msg = lead_status_message(
        status="contacted", public_number="№12", items_count=4,
        estimated_total=314500, currency="RUB",
    )
    assert msg is not None
    assert "№12" in msg.text
    assert "4 товара" in msg.text
    assert "314 500 ₽" in msg.text


def test_single_lead_status_message_uses_product_title():
    msg = lead_status_message(
        status="confirmed", public_number="№7", items_count=0,
        product_title="Dyson HD16",
    )
    assert msg is not None
    assert "Dyson HD16" in msg.text


def test_status_message_has_buttons_when_mini_app_configured(monkeypatch):
    """С настроенным MINI_APP_URL в уведомлении есть вход в «Мои заявки».

    Без этой кнопки сообщение — тупик: человек узнал новость и не может открыть
    заявку, ради которой всё затевалось.
    """
    monkeypatch.setattr("app.core.config.settings.MINI_APP_URL", "https://shop.example")
    msg = lead_status_message(status="contacted", public_number="№1")
    urls = [b["web_app"]["url"] for row in msg.keyboard for b in row if "web_app" in b]
    assert "https://shop.example/requests" in urls


def test_status_message_drops_buttons_when_mini_app_not_configured(monkeypatch):
    """Кнопка с невалидным URL заставляет Telegram отвергнуть ВСЁ сообщение.

    Поэтому лучше уведомление без кнопки, чем отсутствие уведомления.
    """
    monkeypatch.setattr("app.core.config.settings.MINI_APP_URL", "")
    monkeypatch.setattr("app.core.config.settings.MANAGER_RETAIL_URL", "")
    msg = lead_status_message(status="contacted", public_number="№1")
    assert msg.keyboard == []
    assert msg.text


def test_new_lead_message_uses_cart_composition():
    msg = new_lead_message(
        public_number="№12", items_count=3, estimated_total=145000, currency="RUB",
        username="garik", phone="+79990000000",
    )
    assert "№12" in msg.text
    assert "3 товара" in msg.text
    assert "145 000 ₽" in msg.text
    assert "garik" in msg.text
    assert "+79990000000" in msg.text


def test_new_lead_message_uses_product_title_for_single_lead():
    msg = new_lead_message(public_number="№7", product_title="Dyson HD16", username=None)
    assert "Dyson HD16" in msg.text
    assert "покупатель" in msg.text  # без username подписываемся обезличенно


def test_new_lead_message_tags_scenario_types():
    trade_in = new_lead_message(public_number="№1", lead_type="trade_in")
    general = new_lead_message(public_number="№2", lead_type="general")
    assert "Trade-In" in trade_in.text
    assert "Trade-In" not in general.text


def test_new_lead_message_includes_trimmed_comment():
    long_comment = "текст " * 60  # заведомо длиннее 200 символов
    msg = new_lead_message(public_number="№1", message=long_comment)
    assert len(msg.text) < len(long_comment) + 200  # обрезан, а не вставлен целиком
    assert "…" in msg.text


def test_lead_cancelled_by_user_message_mentions_who_and_what():
    msg = lead_cancelled_by_user_message(
        public_number="№9", product_title="iPhone 13 Pro", username="nastya",
    )
    assert "№9" in msg.text
    assert "iPhone 13 Pro" in msg.text
    assert "nastya" in msg.text
    assert "отменил" in msg.text.lower()


def test_cart_reminder_button_opens_the_cart(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.MINI_APP_URL", "https://shop.example")
    msg = cart_reminder_message(items_count=1, estimated_total=100, titles=["X"])
    urls = [b["web_app"]["url"] for row in msg.keyboard for b in row if "web_app" in b]
    assert "https://shop.example/cart" in urls


def test_empty_cart_reminder_is_none():
    """Пустая корзина — не повод для сообщения, и это не ошибка."""
    assert cart_reminder_message(items_count=0, estimated_total=0.0) is None


def test_cart_reminder_lists_titles_and_total():
    msg = cart_reminder_message(
        items_count=2, estimated_total=120500,
        titles=["MacBook Air", "AirPods Pro"],
    )
    assert msg is not None
    assert "MacBook Air" in msg.text and "AirPods Pro" in msg.text
    assert "120 500 ₽" in msg.text


def test_cart_reminder_invents_no_urgency():
    """Корзина ничего не резервирует, поэтому и срочности выдумывать нельзя.

    Проверяем именно ВЫДУМАННЫЕ стимулы. Слова «бронь»/«оплата» в тексте
    допустимы и даже нужны — но только в отрицании («не требуются»), что
    следующий тест и закрепляет.
    """
    msg = cart_reminder_message(items_count=1, estimated_total=1000, titles=["X"])
    lowered = msg.text.lower()
    for invented in ("осталось", "истека", "скидк", "успей", "торопит", "последн"):
        assert invented not in lowered, f"выдуманный стимул: {invented}"


def test_cart_reminder_states_no_payment_required():
    """Заявка — не покупка. Если этого не сказать, напоминание читается как счёт."""
    msg = cart_reminder_message(items_count=1, estimated_total=1000, titles=["X"])
    assert "не требуются" in msg.text.lower()


# ============================ Очередь ============================
def test_enqueue_is_idempotent(db):
    msg = Message("текст")
    first = enqueue(db, chat_id=777, kind="lead_status", message=msg, dedupe_key="k1")
    db.commit()
    second = enqueue(db, chat_id=777, kind="lead_status", message=msg, dedupe_key="k1")
    db.commit()

    assert first is not None and second is None
    assert len(pending(db)) == 1


def test_enqueue_survives_duplicate_without_breaking_transaction(db):
    """Дубль откатывается до SAVEPOINT — внешняя транзакция обязана уцелеть.

    Иначе повторный PATCH статуса рушил бы сам PATCH: уведомление важное, но не
    важнее заявки.
    """
    msg = Message("текст")
    enqueue(db, chat_id=777, kind="lead_status", message=msg, dedupe_key="dup")
    db.commit()

    enqueue(db, chat_id=777, kind="lead_status", message=msg, dedupe_key="dup")
    # После отката до savepoint сессия жива и коммитит другие изменения.
    enqueue(db, chat_id=777, kind="cart_reminder", message=msg, dedupe_key="other")
    db.commit()

    assert {n.dedupe_key for n in pending(db)} == {"dup", "other"}


def test_enqueue_skips_lead_without_telegram_id(db):
    """Заявка не из Telegram — писать некому."""
    assert enqueue(db, chat_id=None, kind="lead_status",
                   message=Message("t"), dedupe_key="k") is None
    assert pending(db) == []


def test_enqueue_skips_silent_template(db):
    assert enqueue(db, chat_id=777, kind="lead_status",
                   message=None, dedupe_key="k") is None
    assert pending(db) == []


# ============================ Отправка ============================
def test_drain_sends_and_marks_sent(db):
    enqueue(db, chat_id=777, kind="lead_status", message=Message("привет"), dedupe_key="k")
    db.commit()

    sent = []
    stats = drain(db, send=lambda row: sent.append(row.text))

    assert stats["sent"] == 1
    assert sent == ["привет"]
    row = pending(db)[0]
    assert row.status == "sent" and row.sent_at is not None and row.last_error is None


def test_drain_does_not_resend_sent(db):
    enqueue(db, chat_id=777, kind="lead_status", message=Message("t"), dedupe_key="k")
    db.commit()
    drain(db, send=lambda row: None)

    calls = []
    drain(db, send=lambda row: calls.append(row))
    assert calls == []


def test_transient_error_keeps_pending(db):
    """Сеть упала — уведомление остаётся в очереди, а не теряется."""
    enqueue(db, chat_id=777, kind="lead_status", message=Message("t"), dedupe_key="k")
    db.commit()

    def boom(row):
        raise TelegramPublishError("Telegram is unavailable")

    stats = drain(db, send=boom)
    row = pending(db)[0]
    assert stats["retry"] == 1
    assert row.status == "pending" and row.attempts == 1
    assert "unavailable" in row.last_error


def test_rate_limit_keeps_pending(db):
    enqueue(db, chat_id=777, kind="lead_status", message=Message("t"), dedupe_key="k")
    db.commit()

    def limited(row):
        raise TelegramRateLimited(20)

    drain(db, send=limited)
    row = pending(db)[0]
    assert row.status == "pending"
    assert "rate limited" in row.last_error


def test_blocked_bot_fails_immediately(db):
    """Человек заблокировал бота — повторять бессмысленно, попытки не тратим."""
    enqueue(db, chat_id=777, kind="lead_status", message=Message("t"), dedupe_key="k")
    db.commit()

    def blocked(row):
        raise TelegramPublishError("Forbidden: bot was blocked by the user")

    drain(db, send=blocked)
    row = pending(db)[0]
    assert row.status == "failed" and row.attempts == 1


def test_transient_error_gives_up_after_max_attempts(db):
    """Вечных pending быть не должно: очередь обязана иметь дно."""
    enqueue(db, chat_id=777, kind="lead_status", message=Message("t"), dedupe_key="k")
    db.commit()

    def boom(row):
        raise TelegramPublishError("Telegram is unavailable")

    for _ in range(MAX_ATTEMPTS):
        drain(db, send=boom)

    row = pending(db)[0]
    assert row.status == "failed" and row.attempts == MAX_ATTEMPTS


def test_one_bad_notification_does_not_block_the_queue(db):
    enqueue(db, chat_id=777, kind="lead_status", message=Message("плохое"), dedupe_key="bad")
    enqueue(db, chat_id=777, kind="lead_status", message=Message("хорошее"), dedupe_key="ok")
    db.commit()

    delivered = []

    def selective(row):
        if row.dedupe_key == "bad":
            raise TelegramPublishError("chat not found")
        delivered.append(row.text)

    stats = drain(db, send=selective)
    assert delivered == ["хорошее"]
    assert stats == {"sent": 1, "failed": 1, "retry": 0}


# ============================ Интеграция с админкой ============================
def test_status_change_enqueues_notification(ctx):
    client, db, _user = ctx
    lead = make_lead(db, items_count=2, estimated_total=100000)

    client.patch(f"/api/admin/leads/{lead.id}", json={"status": "contacted"})

    rows = pending(db)
    assert len(rows) == 1
    assert rows[0].kind == "lead_status"
    assert rows[0].chat_id == 777
    assert rows[0].dedupe_key == f"lead:{lead.id}:status:contacted"
    assert "2 товара" in rows[0].text


def test_status_change_makes_no_network_call(ctx, monkeypatch):
    """В HTTP-запросе админки Telegram не дёргается — только очередь.

    Менеджер не должен ждать прокси, а падение Telegram не имеет права
    превращаться в отказ CRM.
    """
    client, db, _user = ctx
    lead = make_lead(db)

    def explode(*a, **kw):
        raise AssertionError("админка не должна ходить в Telegram синхронно")

    monkeypatch.setattr("app.services.notifications.call", explode)
    response = client.patch(f"/api/admin/leads/{lead.id}", json={"status": "contacted"})
    assert response.status_code == 200


def test_send_never_falls_back_to_the_channel(db, monkeypatch):
    """Адресат уведомления — только личный чат.

    В publisher.send_message пустой адресат подменяется на TELEGRAM_CHANNEL_ID.
    Для постов канала это удобно, здесь — катастрофа: состав и сумма заявки
    конкретного человека ушли бы в открытый канал. Проверяем, что этого пути
    нет: пустой chat_id даёт ошибку, а не публикацию.
    """
    from app.services.notifications import _send

    monkeypatch.setattr("app.core.config.settings.TELEGRAM_CHANNEL_ID", "@public")
    calls = []
    monkeypatch.setattr("app.services.notifications.call",
                        lambda method, payload: calls.append(payload))

    row = Notification(chat_id=0, kind="lead_status", text="секрет", dedupe_key="k")
    with pytest.raises(TelegramPublishError):
        _send(row)
    assert calls == []

    row.chat_id = 777
    _send(row)
    assert calls[0]["chat_id"] == 777


def test_repeated_same_status_does_not_notify_twice(ctx):
    client, db, lead_user = ctx
    lead = make_lead(db)

    client.patch(f"/api/admin/leads/{lead.id}", json={"status": "contacted"})
    client.patch(f"/api/admin/leads/{lead.id}", json={"status": "confirmed"})
    client.patch(f"/api/admin/leads/{lead.id}", json={"status": "contacted"})

    keys = [n.dedupe_key for n in pending(db)]
    assert keys == [f"lead:{lead.id}:status:contacted", f"lead:{lead.id}:status:confirmed"]


def test_status_new_does_not_notify(ctx):
    client, db, _user = ctx
    lead = make_lead(db, status="contacted")

    client.patch(f"/api/admin/leads/{lead.id}", json={"status": "new"})
    assert pending(db) == []


def test_lead_without_telegram_id_does_not_notify(ctx):
    client, db, _user = ctx
    lead = make_lead(db, telegram_id=None)

    response = client.patch(f"/api/admin/leads/{lead.id}", json={"status": "contacted"})
    assert response.status_code == 200
    assert pending(db) == []


def test_status_change_still_applies_when_notification_is_duplicate(ctx):
    """Дубль уведомления не имеет права отменить смену статуса."""
    client, db, _user = ctx
    lead = make_lead(db)
    enqueue(db, chat_id=777, kind="lead_status", message=Message("t"),
            dedupe_key=f"lead:{lead.id}:status:contacted")
    db.commit()

    response = client.patch(f"/api/admin/leads/{lead.id}", json={"status": "contacted"})
    assert response.status_code == 200
    assert response.json()["status"] == "contacted"
    assert len(pending(db)) == 1


def test_assigned_to_change_alone_does_not_notify(ctx):
    """Смена ответственного — внутреннее дело магазина, покупателю не пишем."""
    client, db, _user = ctx
    lead = make_lead(db)

    client.patch(f"/api/admin/leads/{lead.id}", json={"assigned_to": "Иван"})
    assert pending(db) == []


# ------------------------------------------- экранирование (ревизия бота)

def test_product_titles_are_escaped_in_all_templates():
    """Уведомления уходят с parse_mode=HTML — названия обязаны экранироваться.

    Названия приходят из XLSX-импорта, их содержимое магазин не контролирует.
    Одно «&» («Dyson Airwrap & аксессуары») заставит Telegram отклонить
    сообщение ЦЕЛИКОМ: человек не получит ничего, а строка в очереди потратит
    все попытки на ошибку, которая повтором не лечится.
    """
    nasty = "Dyson Airwrap & <Complete>"

    lead = lead_status_message(status="contacted", public_number="№1",
                               product_title=nasty)
    cart = cart_reminder_message(items_count=1, estimated_total=1000, titles=[nasty])
    fav = favorite_message(product_id=1, title=nasty, price=100, previous_price=200)

    for msg in (lead, cart, fav):
        assert "&amp;" in msg.text
        assert "&lt;" in msg.text
        assert nasty not in msg.text, "сырое название просочилось в HTML"


def test_broken_markup_is_permanent_not_retried(db):
    """Сломанная разметка — дефект текста, а не сети.

    Пять повторов дадут пять одинаковых отказов и только задержат очередь.
    """
    enqueue(db, chat_id=777, kind="lead_status", message=Message("t"), dedupe_key="k")
    db.commit()

    def rejected(row):
        raise TelegramPublishError("Bad Request: can't parse entities: unsupported start tag")

    drain(db, send=rejected)
    row = pending(db)[0]
    assert row.status == "failed" and row.attempts == 1
