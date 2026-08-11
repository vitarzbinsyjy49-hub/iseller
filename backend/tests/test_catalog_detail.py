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


def test_memory_duplicating_storage_is_shown_once(db):
    """«Память» и «Накопитель» с одним значением — одна строка, а не две.

    На проде так у ВСЕХ 115 товаров, где эти поля заполнены: колонка memory
    заведена «как в прайсе» и повторяет storage. Человек видел одно и то же
    число дважды под разными подписями и не понимал разницы — её и нет.
    """
    p = make_product(db, memory="512 ГБ", storage="512 ГБ", ram="16 ГБ", specs={})
    values = {s["label"]: s["value"] for s in p.to_detail()["specifications"]}

    assert values["Накопитель"] == "512 ГБ"
    assert "Память" not in values          # дубль убран
    assert values["Оперативная память"] == "16 ГБ"   # ОЗУ — другое поле, остаётся


def test_memory_kept_when_it_differs_from_storage(db):
    """Дедуп по ЗНАЧЕНИЮ, а не по факту «есть оба поля».

    Если завтра импорт положит в memory что-то своё, обе строки обязаны
    остаться: скрывать реальное различие хуже, чем показать две строки.
    """
    p = make_product(db, memory="8 ГБ", storage="256 ГБ", specs={})
    values = {s["label"]: s["value"] for s in p.to_detail()["specifications"]}

    assert values["Память"] == "8 ГБ"
    assert values["Накопитель"] == "256 ГБ"


def test_memory_shown_when_storage_empty(db):
    """Пустой storage не должен прятать единственное, что есть у товара."""
    p = make_product(db, memory="256 ГБ", storage=None, specs={})
    values = {s["label"]: s["value"] for s in p.to_detail()["specifications"]}

    assert values["Память"] == "256 ГБ"


def test_double_spaces_in_values_are_collapsed(db):
    """В прайсе встречается «2  ТБ» с двойным пробелом — в характеристиках
    это читается как опечатка магазина."""
    p = make_product(db, storage="2  ТБ", memory="2  ТБ", specs={})
    values = {s["label"]: s["value"] for s in p.to_detail()["specifications"]}

    assert values["Накопитель"] == "2 ТБ"
    assert "Память" not in values  # схлопнутые пробелы не мешают увидеть дубль


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


def test_card_splits_region_codes_out_of_title():
    """Регион отдаётся списком кодов, а не эмодзи-строкой и не кодом в названии.

    В канале регион давно показывается эмодзи-флагом, на витрине название
    приходило как есть — и на узкой карточке «(HK-KR, SIM+eSIM)» ещё и
    обрезалось. Список кодов, а не готовые эмодзи: Windows штатно не
    собирает пару «региональных индикаторов» в картинку флага и показывает
    их как есть, буквами («🇮🇳🇺🇸🇭🇰» -> нечитаемое «INUSHK») — витрина рисует
    коды своими SVG. Разбирает тот же split_region_codes, что и канал
    (через обёртку split_region), поэтому они не могут разойтись.
    """
    from app.models.product import Product

    card = Product(title="Apple iPhone 17 Pro 256 ГБ Blue (HK-KR, SIM+eSIM)",
                   price=99800, category="смартфоны").to_card()

    assert card["region_codes"] == ["HK", "KR"]
    assert card["title_clean"] == "Apple iPhone 17 Pro 256 ГБ Blue (SIM+eSIM)"
    # Оригинал не трогаем: по нему ищут, им делятся, он уходит в AI.
    assert card["title"] == "Apple iPhone 17 Pro 256 ГБ Blue (HK-KR, SIM+eSIM)"


def test_card_without_region_keeps_title_intact():
    """Нет кода страны — пустой список кодов, название остаётся прежним."""
    from app.models.product import Product

    card = Product(title="Dyson Airwrap Complete", price=45000,
                   category="красота").to_card()

    assert card["region_codes"] == []
    assert card["title_clean"] == "Dyson Airwrap Complete"
