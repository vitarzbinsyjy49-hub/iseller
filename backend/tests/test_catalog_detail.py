"""Тесты нормализованных характеристик (to_detail.specifications) и секций /feed."""
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


def test_specifications_merges_specs_and_columns(db):
    p = make_product(
        db, title="iPhone", brand="Apple", condition="used", color="Титановый",
        cpu="A17 Pro", warranty_months=12,
        specs={"экран": '6.1" OLED', "память": "256 ГБ"},
    )
    spec = p.to_detail()["specifications"]
    values = {s["label"]: s["value"] for s in spec}
    labels = [s["label"] for s in spec]
    # свободные specs идут первыми и сохраняются
    assert values["Экран"] == '6.1" OLED'
    assert values["Память"] == "256 ГБ"
    # структурные колонки добавляют новое
    assert values["Бренд"] == "Apple"
    assert values["Состояние"] == "Б/у"
    assert values["Цвет"] == "Титановый"
    assert values["Процессор"] == "A17 Pro"
    assert values["Гарантия"] == "12 мес."
    # без дублей подписей (регистронезависимо)
    assert len(labels) == len({l.lower() for l in labels})


def test_specifications_condition_new_hidden(db):
    p = make_product(db, condition="new", specs={})
    labels = [s["label"] for s in p.to_detail()["specifications"]]
    assert "Состояние" not in labels  # «Новый» по умолчанию не показываем


def test_specifications_empty_when_no_data(db):
    p = make_product(
        db, specs={}, brand=None, warranty_months=0, condition="new",
        color=None, cpu=None, ram=None, memory=None, storage=None, screen_size=None,
    )
    assert p.to_detail()["specifications"] == []


def test_specifications_bool_and_list(db):
    p = make_product(db, specs={"eSIM": True, "комплект": ["кабель", "чехол"]})
    values = {s["label"]: s["value"] for s in p.to_detail()["specifications"]}
    assert values["ESIM"] == "Да"
    assert values["Комплект"] == "кабель, чехол"


def test_feed_has_four_sections_recommended_dedup(client, db):
    for i in range(12):
        make_product(db, title=f"Товар {i}", popularity=i, sku=f"SKU{i}",
                     is_hot=(i % 4 == 0), is_new=(i % 5 == 0))
    data = client.get("/api/catalog/feed").json()
    assert set(data) == {"hot", "available_today", "new", "recommended"}
    assert len(data["recommended"]) <= 8
    shown = {c["id"] for c in data["hot"]} | {c["id"] for c in data["new"]}
    rec_ids = {c["id"] for c in data["recommended"]}
    assert rec_ids.isdisjoint(shown)         # рекомендуем не дублирует hot/new
    assert len(data["recommended"]) >= 1
