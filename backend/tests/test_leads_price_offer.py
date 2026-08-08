"""Заявка «нашли дешевле» (price_offer): ссылка на конкурента с карточки товара.

Покрывает нормализацию ссылки на входе, цену со слов покупателя, снапшот нашей
цены, защиту от двойной отправки и уведомление владельцу.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.lead import Lead
from app.models.notification import Notification
from app.models.user import User
from tests.conftest import make_product


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=777, first_name="Гриша", username="grisha")
    db.add(u)
    db.commit()
    db.refresh(u)
    product = make_product(db, title="iPhone 17 Pro 256 ГБ", price=104000)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, product
    finally:
        app.dependency_overrides.clear()


def _post(client, product_id, **meta):
    body = {
        "lead_type": "price_offer",
        "source": "product",
        "product_id": product_id,
        "metadata": {"origin": "product_price_offer", **meta},
    }
    return client.post("/api/leads", json=body)


# ---------------- ссылка ----------------

def test_normalizes_url_and_names_shop(ctx):
    client, _db, product = ctx
    r = _post(client, product.id, competitor_url="www.mvideo.ru/product/x?utm_source=tg")
    assert r.status_code == 201
    meta = r.json()["metadata"]
    assert meta["competitor_url"] == "https://www.mvideo.ru/product/x"
    assert meta["competitor_shop"] == "М.Видео"


@pytest.mark.parametrize("bad", [
    "javascript:alert(1)",      # схемы нет => дописываем https:// и падаем на хосте
    "javascript://alert(1)",    # схема есть и она не http
    "дешевле в соседнем магазине",
    "https://158.255.1.248.sslip.io/product/42",
])
def test_rejects_bad_url(ctx, bad):
    client, _db, product = ctx
    r = _post(client, product.id, competitor_url=bad)
    assert r.status_code == 422
    # Текст отказа показывается человеку — он обязан быть человеческим.
    assert r.json()["detail"] and not r.json()["detail"].startswith("<")


def test_rejects_missing_url(ctx):
    """Заявка «нашли дешевле» без ссылки бессмысленна — она вся про ссылку."""
    client, _db, product = ctx
    r = _post(client, product.id)
    assert r.status_code == 422


# ---------------- цена ----------------

def test_keeps_competitor_price(ctx):
    client, _db, product = ctx
    r = _post(client, product.id, competitor_url="https://ozon.ru/p/1", competitor_price=97500)
    assert r.status_code == 201
    body = r.json()
    assert body["metadata"]["competitor_price"] == 97500
    # Наша цена — снапшот из каталога, клиенту не доверяем.
    assert body["product_price"] == 104000


def test_price_is_optional(ctx):
    client, _db, product = ctx
    r = _post(client, product.id, competitor_url="https://ozon.ru/p/1")
    assert r.status_code == 201
    assert "competitor_price" not in r.json()["metadata"]


def test_rejects_non_positive_price(ctx):
    client, _db, product = ctx
    r = _post(client, product.id, competitor_url="https://ozon.ru/p/1", competitor_price=0)
    assert r.status_code == 422


def test_rejects_absurd_price(ctx):
    client, _db, product = ctx
    r = _post(client, product.id, competitor_url="https://ozon.ru/p/1",
              competitor_price=10**12)
    assert r.status_code == 422


def test_rejects_unparsable_price(ctx):
    client, _db, product = ctx
    r = _post(client, product.id, competitor_url="https://ozon.ru/p/1",
              competitor_price="дешевле")
    assert r.status_code == 422


# ---------------- двойная отправка ----------------

def test_repeat_returns_same_lead(ctx):
    """Двойной тап не имеет права создать вторую заявку и второй раз дёрнуть
    владельца в Telegram."""
    client, db, product = ctx
    first = _post(client, product.id, competitor_url="https://ozon.ru/p/1")
    second = _post(client, product.id, competitor_url="ozon.ru/p/1")
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert db.query(Lead).filter_by(lead_type="price_offer").count() == 1


def test_other_link_creates_new_lead(ctx):
    client, db, product = ctx
    _post(client, product.id, competitor_url="https://ozon.ru/p/1")
    _post(client, product.id, competitor_url="https://www.mvideo.ru/p/2")
    assert db.query(Lead).filter_by(lead_type="price_offer").count() == 2


# ---------------- уведомление владельцу ----------------

def test_enqueues_owner_notification(ctx, monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_ID", "12345", raising=False)

    client, db, product = ctx
    r = _post(client, product.id, competitor_url="https://www.mvideo.ru/p/1",
              competitor_price=97500)
    assert r.status_code == 201

    rows = db.query(Notification).filter_by(kind="price_offer").all()
    assert len(rows) == 1
    assert rows[0].chat_id == 12345
    assert "М.Видео" in rows[0].text
    assert "https://www.mvideo.ru/p/1" in rows[0].text


def test_no_owner_chat_means_no_notification(ctx, monkeypatch):
    """Пустая настройка — это локальный стенд, а не сбой: заявка всё равно жива."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_ID", "", raising=False)

    client, db, product = ctx
    r = _post(client, product.id, competitor_url="https://ozon.ru/p/1")
    assert r.status_code == 201
    assert db.query(Notification).filter_by(kind="price_offer").count() == 0


def test_notification_shows_both_prices_and_gap(ctx, monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_ID", "12345", raising=False)

    client, db, product = ctx
    _post(client, product.id, competitor_url="https://ozon.ru/p/1", competitor_price=97500)
    text = db.query(Notification).filter_by(kind="price_offer").one().text
    assert "104 000" in text      # наша
    assert "97 500" in text       # у них
    assert "6 500" in text        # разница


# ---------------- шаблон ----------------

def test_message_without_price_says_so():
    from app.services.notification_templates import price_offer_message

    msg = price_offer_message(
        product_title="iPhone 17 Pro 256", our_price=104000, competitor_price=None,
        competitor_url="https://ozon.ru/p/1", competitor_shop="Ozon", username=None,
    )
    assert "Ozon" in msg.text
    assert "https://ozon.ru/p/1" in msg.text
    assert "не указана" in msg.text.lower()


# ---------------- обратные тексты покупателю ----------------

def test_status_text_differs_for_price_offer():
    """У «нашли дешевле» свой разговор: он про цену, а не про состав заказа."""
    from app.services.notification_templates import lead_status_message

    generic = lead_status_message(status="confirmed", public_number="№1")
    offer = lead_status_message(status="confirmed", public_number="№1",
                                lead_type="price_offer")
    assert generic is not None and offer is not None
    assert generic.text != offer.text
    assert "цену" in offer.text.lower()


def test_status_overlay_does_not_wake_silent_statuses():
    """Оверлей переопределяет тексты, но не расширяет набор уведомлений."""
    from app.services.notification_templates import lead_status_message

    assert lead_status_message(status="in_progress", public_number="№1",
                               lead_type="price_offer") is None
    assert lead_status_message(status="new", public_number="№1",
                               lead_type="price_offer") is None


def test_unknown_lead_type_falls_back_to_generic_text():
    from app.services.notification_templates import lead_status_message

    generic = lead_status_message(status="contacted", public_number="№1")
    other = lead_status_message(status="contacted", public_number="№1", lead_type="cart")
    assert generic is not None and other is not None
    assert generic.text == other.text


def test_admin_status_change_notifies_buyer_with_offer_wording(ctx, monkeypatch):
    """Сквозь админку: менеджер подтвердил — покупателю ушёл текст про цену."""
    from app.services import notifications as notifications_service

    monkeypatch.setattr(notifications_service, "notifications_enabled", lambda: True)
    monkeypatch.setattr("app.api.admin_crm.notifications_enabled", lambda: True)

    client, db, product = ctx
    created = _post(client, product.id, competitor_url="https://ozon.ru/p/1")
    lead_id = created.json()["id"]

    r = client.patch(f"/api/admin/leads/{lead_id}", json={"status": "confirmed"})
    assert r.status_code == 200

    row = db.query(Notification).filter_by(kind="lead_status").one()
    assert row.chat_id == 777
    assert "цену" in row.text.lower()


def test_message_escapes_product_title():
    """Название из XLSX-импорта магазин не контролирует: «&» отклонит пост целиком."""
    from app.services.notification_templates import price_offer_message

    msg = price_offer_message(
        product_title="Dyson Airwrap & аксессуары", our_price=None, competitor_price=None,
        competitor_url="https://ozon.ru/p/1", competitor_shop="Ozon", username="ivan",
    )
    assert "&amp;" in msg.text
