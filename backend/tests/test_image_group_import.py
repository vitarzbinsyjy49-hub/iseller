"""v5.2.6 — импорт галерей в режиме MODEL_COLOR.

Галерея назначается ВСЕМ вариантам модели одного цвета (не одному SKU).
Неоднозначное/неполное описание группы -> ошибка, без «угадывания».
"""
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.main import app
from app.models.product import Product
from app.models.product_image_group import ProductImageGroup
from app.services.image_groups import resolve_product_images
from tests.conftest import make_product

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40


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


def _zip(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, b in files.items():
            z.writestr(n, b if isinstance(b, bytes) else b.encode())
    return buf.getvalue()


def test_preview_reports_affected_variants(client, db):
    make_product(db, sku="IP16P-128-BLK", title="iPhone 16 Pro 128 ГБ Black", color="Black", price=100000)
    make_product(db, sku="IP16P-256-BLK", title="iPhone 16 Pro 256 ГБ Black", color="Black", price=110000)
    make_product(db, sku="IP16P-256-WHT", title="iPhone 16 Pro 256 ГБ White", color="White", price=110000)
    manifest = {"image_groups": [{
        "brand": "Apple", "model": "iPhone 16 Pro", "color": "Black",
        "files": ["front.png", "back.png"], "primary": "front.png",
    }]}
    r = client.post(
        "/api/admin/import/image-groups/preview",
        files=[("file", ("g.zip", _zip({"manifest.json": json.dumps(manifest), "front.png": PNG, "back.png": PNG}), "application/zip"))],
    )
    assert r.status_code == 200, r.text
    g = r.json()["groups"][0]
    assert g["affected_variants"] == 2          # оба Black; White не входит
    assert g["present"] == ["front.png", "back.png"] and not g["missing"]
    assert not g["errors"]


def test_confirm_creates_group_and_unifies_variants(client, db):
    make_product(db, sku="IP16P-128-BLK", title="iPhone 16 Pro 128 ГБ Black", color="Black", price=100000)
    make_product(db, sku="IP16P-256-BLK", title="iPhone 16 Pro 256 ГБ Black", color="Black", price=110000)
    manifest = {"matchMode": "model_color", "brand": "Apple", "model": "iPhone 16 Pro",
                "color": "Black", "files": ["front.png", "back.png"], "primary": "front.png"}
    r = client.post(
        "/api/admin/import/image-groups/confirm",
        files=[("file", ("g.zip", _zip({"manifest.json": json.dumps(manifest), "front.png": PNG, "back.png": PNG}), "application/zip"))],
    )
    assert r.status_code == 200, r.text
    assert r.json()["groups_applied"] == 1
    grp = db.query(ProductImageGroup).one()
    assert len(grp.images) == 2 and grp.image == grp.images[0]
    # оба варианта модели+цвета теперь показывают галерею группы
    blacks = db.query(Product).filter(Product.color == "Black").all()
    res = resolve_product_images(db, blacks)
    for r2 in res.values():
        assert r2["images"] == grp.images


def test_missing_color_is_error_not_guessed(client, db):
    manifest = {"image_groups": [{"brand": "Apple", "model": "iPhone 16 Pro", "files": ["front.png"]}]}
    r = client.post(
        "/api/admin/import/image-groups/preview",
        files=[("file", ("g.zip", _zip({"manifest.json": json.dumps(manifest), "front.png": PNG}), "application/zip"))],
    )
    assert r.status_code == 200, r.text
    assert r.json()["groups"][0]["errors"]      # без цвета — ошибка, не применяется


def test_no_manifest_rejected(client, db):
    r = client.post(
        "/api/admin/import/image-groups/preview",
        files=[("file", ("g.zip", _zip({"front.png": PNG}), "application/zip"))],
    )
    assert r.status_code == 400
