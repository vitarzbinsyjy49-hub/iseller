"""GET /catalog/by-ids — свежие карточки по списку id.

Нужен восстановлению разговора с AI: лента диалога хранится на устройстве
ТЕКСТОМ И ID, без карточек. Карточка — снимок цены и наличия, и держать её
сутки в localStorage значит однажды показать вчерашнюю цену.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User
from tests.conftest import make_product


@pytest.fixture()
def client(db):
    def override_db():
        yield db

    def override_user():
        u = db.query(User).first()
        if u is None:
            u = User(telegram_id=1)
            db.add(u)
            db.commit()
            db.refresh(u)
        return u

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_returns_cards_in_requested_order(client, db):
    a = make_product(db, title="Первый", price=1000)
    b = make_product(db, title="Второй", price=2000)
    c = make_product(db, title="Третий", price=3000)

    r = client.get(f"/api/catalog/by-ids?ids={c.id},{a.id},{b.id}")
    assert r.status_code == 200
    # Порядок ЗАПРОСА, а не базы: в ленте диалога товары стоят так, как их
    # выдала модель, и переставлять их при восстановлении нельзя.
    assert [card["title"] for card in r.json()["cards"]] == ["Третий", "Первый", "Второй"]


def test_inactive_product_does_not_come_back(client, db):
    alive = make_product(db, title="Живой")
    dead = make_product(db, title="Снятый", is_active=False)

    r = client.get(f"/api/catalog/by-ids?ids={alive.id},{dead.id}")
    # Снятый с продажи товар просто исчезает из старого разговора — это честнее,
    # чем показать карточку, которую уже нельзя купить.
    assert [card["id"] for card in r.json()["cards"]] == [alive.id]


def test_prices_are_current_not_remembered(client, db):
    p = make_product(db, title="Подорожал", price=1000)
    p.price = 1500
    db.commit()

    r = client.get(f"/api/catalog/by-ids?ids={p.id}")
    # Ровно ради этого эндпоинт и существует.
    assert r.json()["cards"][0]["price"] == 1500


def test_garbage_ids_are_ignored_not_fatal(client, db):
    p = make_product(db, title="Живой")

    r = client.get(f"/api/catalog/by-ids?ids=абв,,{p.id},-5,999999")
    assert r.status_code == 200
    assert [card["id"] for card in r.json()["cards"]] == [p.id]


def test_empty_request_gives_empty_list(client):
    assert client.get("/api/catalog/by-ids?ids=").json() == {"cards": []}


def test_duplicate_ids_are_not_duplicated_in_answer(client, db):
    p = make_product(db, title="Один")
    r = client.get(f"/api/catalog/by-ids?ids={p.id},{p.id}")
    assert [card["id"] for card in r.json()["cards"]] == [p.id]


def test_request_is_capped(client, db):
    ids = ",".join(str(i) for i in range(1, 100))
    r = client.get(f"/api/catalog/by-ids?ids={ids}")
    # Ограничение — защита от запроса всего каталога одной строкой.
    assert r.status_code == 200
    assert len(r.json()["cards"]) <= 24
