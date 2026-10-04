"""Новинка — модель, впервые появившаяся в каталоге не раньше окна назад.

Спека: docs/superpowers/specs/2026-10-04-novelty-ranking-and-ai-design.md.
На проде 04.10 ручной `is_new` стоял у 307 из 488 товаров, включая стартовый
импорт 20.07, — флаг перестал что-либо значить. Теперь его ставит система по
дате первого появления МОДЕЛИ, и он гаснет сам, когда окно уходит вперёд.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.main import app
from app.models.product import Product
from app.services import novelty
from app.services.novelty import is_fresh, novelty_cutoff, prefers_new, sync_novelty
from tests.conftest import make_product

#: «Сейчас» — настоящее: эндпоинты админки синхронизируют по живым часам, и
#: фиксированная дата разъехалась бы с ними на машине с другим календарём.
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def _ago(days: float) -> datetime:
    return NOW - timedelta(days=days)


def _p(db, title, family=None, days=0.0, **kw):
    return make_product(db, title=title, family_key=family, created_at=_ago(days), **kw)


def _reload(db, p):
    db.expire_all()
    return db.get(Product, p.id)


# ---------------------------------------------------------------- определение

def test_new_model_is_new_old_model_is_not(db):
    fresh = _p(db, "iPhone 18 Pro 256 Black", "Apple iPhone 18 Pro", days=3)
    old = _p(db, "iPhone 17 Pro 256 Blue", "Apple iPhone 17 Pro", days=80)
    sync_novelty(db, now=NOW)
    assert _reload(db, fresh).is_new is True
    assert _reload(db, old).is_new is False


def test_new_colour_of_old_model_is_not_a_novelty(db):
    """Новый цвет iPhone 17 не делает его новинкой: дата — у МОДЕЛИ."""
    _p(db, "iPhone 17 Pro 256 Blue", "Apple iPhone 17 Pro", days=80)
    colour = _p(db, "iPhone 17 Pro 256 Orange", "Apple iPhone 17 Pro", days=1)
    sync_novelty(db, now=NOW)
    colour = _reload(db, colour)
    assert colour.is_new is False
    assert colour.model_first_seen_at.replace(tzinfo=None) == _ago(80).replace(tzinfo=None)


def test_inactive_variant_still_counts_for_first_seen(db):
    """Снятый и вернувшийся вариант не делает модель новой."""
    _p(db, "iPhone 17 Pro 256 Blue", "Apple iPhone 17 Pro", days=200, is_active=False)
    back = _p(db, "iPhone 17 Pro 512 Blue", "Apple iPhone 17 Pro", days=2)
    sync_novelty(db, now=NOW)
    assert _reload(db, back).is_new is False


def test_product_without_family_is_its_own_model(db):
    """Без семейства (и без правила склейки) товар — сам себе модель."""
    lone = _p(db, "Чехол кожаный коричневый", None, days=2, category="аксессуары", brand="NoName")
    other = _p(db, "Чехол силиконовый синий", None, days=300, category="аксессуары", brand="NoName")
    sync_novelty(db, now=NOW)
    assert _reload(db, lone).is_new is True
    assert _reload(db, other).is_new is False


def test_all_variants_of_a_model_carry_the_same_date(db):
    a = _p(db, "iPhone 18 256 Black", "Apple iPhone 18", days=10)
    b = _p(db, "iPhone 18 512 White", "Apple iPhone 18", days=4)
    sync_novelty(db, now=NOW)
    a, b = _reload(db, a), _reload(db, b)
    assert a.model_first_seen_at == b.model_first_seen_at
    assert a.is_new is b.is_new is True


def test_showcase_of_old_model_is_not_a_novelty(db):
    """Витринный образец живёт отдельным семейством с суффиксом, но модель та же:
    уценённый iPhone 17, заведённый вчера, — не новинка."""
    _p(db, "iPhone 17 256 Blue", "Apple iPhone 17", days=90)
    asis = _p(db, "iPhone 17 256 Blue [ASIS]", "Apple iPhone 17 — витринный образец", days=1)
    sync_novelty(db, now=NOW)
    assert _reload(db, asis).is_new is False


def test_manual_is_new_is_overwritten(db):
    """Ручной флаг больше ничего не решает: стартовый импорт с is_new=True гаснет."""
    old = _p(db, "AirPods Pro 2", "Apple AirPods Pro 2", days=76, is_new=True)
    sync_novelty(db, now=NOW)
    assert _reload(db, old).is_new is False


# ---------------------------------------------------------------- поведение

def test_sync_is_idempotent(db):
    _p(db, "iPhone 18 256 Black", "Apple iPhone 18", days=3)
    _p(db, "iPhone 17 256 Blue", "Apple iPhone 17", days=80)
    assert sync_novelty(db, now=NOW) == 2
    assert sync_novelty(db, now=NOW) == 0


def test_novelty_expires_when_window_moves(db):
    """Окно сдвигается со временем — флаг обязан гаснуть сам, без админки."""
    p = _p(db, "iPhone 18 256 Black", "Apple iPhone 18", days=40)
    sync_novelty(db, now=NOW)
    assert _reload(db, p).is_new is True
    assert sync_novelty(db, now=NOW + timedelta(days=10)) == 1
    assert _reload(db, p).is_new is False


def test_scoped_sync_touches_only_given_models(db):
    a = _p(db, "iPhone 18 256 Black", "Apple iPhone 18", days=3)
    b = _p(db, "Dyson V16", "Dyson V16", days=3, brand="Dyson")
    assert sync_novelty(db, family_keys={"Apple iPhone 18"}, now=NOW) == 1
    assert _reload(db, a).is_new is True
    assert _reload(db, b).model_first_seen_at is None


def test_window_comes_from_settings(db, monkeypatch):
    monkeypatch.setattr(novelty.settings, "NOVELTY_WINDOW_DAYS", 10)
    assert novelty_cutoff(NOW) == NOW - timedelta(days=10)
    p = _p(db, "iPhone 18 256 Black", "Apple iPhone 18", days=20)
    sync_novelty(db, now=NOW)
    assert _reload(db, p).is_new is False


def test_is_fresh(db):
    fresh = _p(db, "iPhone 18 256 Black", "Apple iPhone 18", days=3)
    old = _p(db, "iPhone 17 256 Blue", "Apple iPhone 17", days=80)
    unsynced = _p(db, "iPhone 16 256 Blue", "Apple iPhone 16", days=1)
    sync_novelty(db, family_keys={"Apple iPhone 18", "Apple iPhone 17"}, now=NOW)
    assert is_fresh(_reload(db, fresh), now=NOW) is True
    assert is_fresh(_reload(db, old), now=NOW) is False
    assert is_fresh(_reload(db, unsynced), now=NOW) is False   # даты ещё нет


# ---------------------------------------------------------------- слова запроса

@pytest.mark.parametrize("text", [
    "что нового из телефонов", "новинки", "Новинки Apple", "хочу новый айфон",
    "какой последний айфон", "самые свежие ноутбуки", "вышла ли новая модель",
    "вышедшие недавно", "что вышло", "новейший макбук", "latest iphone", "new macbook",
])
def test_prefers_new_catches_novelty_words(text):
    assert prefers_new(text) is True


@pytest.mark.parametrize("text", [
    "доставка в Новосибирск", "магазин в Новгороде", "айфон 17", "renew",
    "ноутбук для учёбы", "",
])
def test_prefers_new_ignores_lookalikes(text):
    assert prefers_new(text) is False


# ---------------------------------------------------------------- админка

@pytest.fixture()
def client(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_admin_ignores_is_new_from_body(client, db):
    old = _p(db, "iPhone 17 256 Blue", "Apple iPhone 17", days=80)
    sync_novelty(db)
    r = client.patch(f"/api/admin/products/{old.id}", json={"is_new": True, "price": 1000})
    assert r.status_code == 200
    assert _reload(db, old).is_new is False


def test_admin_create_marks_new_model_and_exposes_window(client, db):
    r = client.post("/api/admin/products", json={
        "title": "Nothing Phone 4", "price": 50000, "family_key": "Nothing Phone 4",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["is_new"] is True
    assert body["model_first_seen_at"]
    assert body["novelty_until"]          # дата, до которой модель — новинка


def test_admin_create_new_colour_of_old_model_is_not_new(client, db):
    _p(db, "iPhone 17 256 Blue", "Apple iPhone 17", days=80)
    r = client.post("/api/admin/products", json={
        "title": "iPhone 17 256 Orange", "price": 90000, "family_key": "Apple iPhone 17",
    })
    assert r.status_code == 201
    assert r.json()["is_new"] is False


def test_admin_import_syncs_novelty(client, db):
    r = client.post("/api/admin/products/import", json=[
        {"title": "Nothing Phone 4 Black", "price": 50000, "is_new": False},
    ])
    assert r.status_code == 200
    p = db.query(Product).filter_by(title="Nothing Phone 4 Black").one()
    db.refresh(p)
    assert p.is_new is True                # решает система, а не тело импорта


def test_colour_added_without_family_key_joins_its_model_by_rules(db):
    """Админка и Import Center заводят товары без family_key. Модель тогда
    определяют те же правила, что склеивают карточки на витрине, — иначе
    новый цвет iPhone 17, заведённый руками, стал бы «новинкой»."""
    _p(db, "iPhone 17 Pro 256 ГБ Blue", None, days=90)
    colour = _p(db, "iPhone 17 Pro 512 ГБ Orange", None, days=1)
    sync_novelty(db, now=NOW)
    assert _reload(db, colour).is_new is False
