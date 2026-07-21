"""v5.2.6 — приём событий и персональные рекомендации.

Проверяет валидацию/дедуп/изоляцию событий и свойства скоринга: разнообразие
для нового пользователя, усиление по просмотрам/заявкам, исключение скрытых и
только что просмотренных, отсутствие вариантов-дублей, «недавно смотрели».
"""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user_product_event import UserProductEvent
from app.services.recommendations import recently_viewed, recommend, record_event
from tests.conftest import make_product


@pytest.fixture()
def client(db):
    def override_db():
        yield db
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1, telegram_id="1", first_name="U", username=None)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# ---------- приём событий ----------

def test_event_unknown_type_rejected(client, db):
    p = make_product(db, title="X")
    r = client.post("/api/events/product", json={"event_type": "bogus", "product_id": p.id})
    assert r.status_code == 400


def test_event_invalid_product_404(client, db):
    r = client.post("/api/events/product", json={"event_type": "product_view", "product_id": 99999})
    assert r.status_code == 404


def test_event_records_and_dedups(client, db):
    p = make_product(db, title="X")
    r1 = client.post("/api/events/product", json={"event_type": "product_view", "product_id": p.id})
    assert r1.status_code == 202 and r1.json()["recorded"] is True
    r2 = client.post("/api/events/product", json={"event_type": "product_view", "product_id": p.id})
    assert r2.json()["recorded"] is False               # дедуп в коротком окне
    assert db.query(UserProductEvent).filter_by(user_id=1).count() == 1


def test_event_isolated_to_current_user(client, db):
    p = make_product(db, title="X")
    client.post("/api/events/product", json={"event_type": "product_view", "product_id": p.id})
    # событие принадлежит user_id=1 (из JWT), не тому, что мог бы прислать клиент
    assert db.query(UserProductEvent).filter_by(user_id=1).count() == 1
    assert db.query(UserProductEvent).filter(UserProductEvent.user_id != 1).count() == 0


# ---------- скоринг: разнообразие для нового пользователя ----------

def test_new_user_not_only_headphones(db):
    for i in range(8):
        make_product(db, title=f"Buds {i}", category="наушники", popularity=30 - i)
    for i in range(4):
        make_product(db, title=f"Phone {i}", category="смартфоны", popularity=10)
    for i in range(4):
        make_product(db, title=f"Laptop {i}", category="ноутбуки", popularity=10)
    recs, reasons, mode = recommend(db, user_id=1, limit=8)
    assert mode == "cold"
    cats = [p.category for p in recs]
    assert cats.count("наушники") < len(recs)      # НЕ только наушники
    assert len(set(cats)) >= 3                      # разные категории
    assert reasons                                   # есть reason-подсказки


# ---------- скоринг: усиление по поведению ----------

def test_views_and_lead_boost_affinity(db):
    iph = make_product(db, title="iPhone 16 Pro Black", brand="Apple", category="смартфоны", color="Black", popularity=1)
    make_product(db, title="MacBook Air Black", brand="Apple", category="ноутбуки", color="Black", popularity=1)
    for i in range(10):
        make_product(db, title=f"Sony Buds {i}", brand="Sony", category="наушники", popularity=50)
    record_event(db, 1, "product_view", product_id=iph.id, category="смартфоны")
    record_event(db, 1, "lead_created", product_id=iph.id, category="смартфоны")
    recs, reasons, mode = recommend(db, 1, limit=8)
    assert mode == "intent"                          # есть заявка -> режим intent
    assert "Apple" in [p.brand for p in recs[:4]]    # Apple вытянут выше популярных Sony
    assert any(p.brand != "Apple" for p in recs)     # но исследование сохранено


def test_recent_viewed_excluded_from_recs(db):
    seen = make_product(db, title="iPhone 16 Pro Black", brand="Apple", category="смартфоны", color="Black", popularity=1)
    make_product(db, title="MacBook", brand="Apple", category="ноутбуки", popularity=1)
    record_event(db, 1, "product_view", product_id=seen.id, category="смартфоны")
    recs, _, _ = recommend(db, 1, limit=8)
    assert seen.id not in [p.id for p in recs]       # только что смотрел -> не в «Для вас»


def test_hidden_products_excluded(db):
    make_product(db, title="Visible", popularity=1)
    make_product(db, title="Hidden", is_active=False, popularity=100)
    recs, _, _ = recommend(db, 1, limit=8)
    assert all(p.is_active for p in recs)
    assert "Hidden" not in [p.title for p in recs]


def test_no_variant_duplicates_in_recs(db):
    for mem in ("128 ГБ", "256 ГБ", "512 ГБ"):
        make_product(db, title=f"iPhone 16 Pro {mem} Black", brand="Apple", color="Black",
                     category="смартфоны", popularity=80)
    make_product(db, title="MacBook", brand="Apple", category="ноутбуки", popularity=1)
    recs, _, _ = recommend(db, 1, limit=8)
    same_model = [p for p in recs if p.title.startswith("iPhone 16 Pro")]
    assert len(same_model) <= 1                      # варианты памяти не плодят дубли


# ---------- недавно смотрели ----------

def test_recently_viewed_order_and_dedup(db):
    a = make_product(db, title="A")
    b = make_product(db, title="B")
    record_event(db, 1, "product_view", product_id=b.id)
    record_event(db, 1, "product_view", product_id=a.id)
    rv = recently_viewed(db, 1, limit=5)
    assert [p.id for p in rv] == [a.id, b.id]         # последний просмотр первым, без дублей
