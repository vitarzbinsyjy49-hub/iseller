"""GET /api/deeplink/{payload} — резолвер payload'а в путь Mini App.

Нужен фронту для запуска по ?startapp=<payload> (прямой переход в Mini App,
минуя чат с ботом): в отличие от ?start=, тут payload приходит НЕ в текстовое
сообщение боту, а в initDataUnsafe.start_param на самом фронте, и путь для
навигации фронт узнаёт отсюда. Эндпоинт без auth: тот же payload и так открыт
всем в кнопках канала, ничего приватного тут нет.
"""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_known_payload_resolves_to_a_route():
    r = client.get("/api/deeplink/catalog")
    assert r.status_code == 200
    assert r.json() == {"route": "/catalog"}


def test_product_payload_resolves():
    r = client.get("/api/deeplink/product_42")
    assert r.status_code == 200
    assert r.json() == {"route": "/product/42"}


def test_section_payload_resolves():
    from app.services.price_posts import SECTIONS_BY_SLUG

    r = client.get("/api/deeplink/price_iphone")
    assert r.status_code == 200
    assert r.json() == {"route": SECTIONS_BY_SLUG["price_iphone"].route}


def test_unknown_payload_is_404():
    r = client.get("/api/deeplink/совсем-не-существует")
    assert r.status_code == 404
