"""Галерея товара (v5.4.0): единый лимит 10, инварианты порядка/главной,
мультизагрузка, reorder, эффективная галерея в карточке, ZIP-excess.
"""
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.core.uploads import MAX_PRODUCT_IMAGES, normalize_gallery
from app.db.session import get_db
from app.main import app
from app.models.product import Product
from app.services.image_groups import resolve_product_images
from tests.conftest import make_product

JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32


@pytest.fixture()
def client(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    app.dependency_overrides[get_current_user] = lambda: _ensure_user(db)
    try:
        yield TestClient(app), db
    finally:
        app.dependency_overrides.clear()


def _ensure_user(db):
    from app.models.user import User
    u = db.query(User).first()
    if u is None:
        u = User(telegram_id=1, first_name="U")
        db.add(u); db.commit(); db.refresh(u)
    return u


# ---------------- нормализатор ----------------

def test_max_constant_is_ten():
    assert MAX_PRODUCT_IMAGES == 10


def test_normalize_gallery_dedupe_main_cap():
    urls = ["b", "a", "b", "", "c"]
    kept, excess = normalize_gallery(urls, main="a")
    assert kept == ["a", "b", "c"]        # главная первой, дубли/пустые убраны
    assert excess == []
    big = [f"u{i}" for i in range(15)]
    kept, excess = normalize_gallery(big)
    assert len(kept) == 10 and len(excess) == 5


# ---------------- лимит на загрузке ----------------

def test_eleventh_image_rejected(client):
    c, db = client
    p = make_product(db, images=[f"/api/uploads/x{i}.jpg" for i in range(10)], image="/api/uploads/x0.jpg")
    r = c.post(f"/api/admin/products/{p.id}/images",
               files={"file": ("k.jpg", JPG, "image/jpeg")})
    assert r.status_code == 400
    assert "10" in r.json()["detail"]


def test_tenth_image_allowed(client):
    c, db = client
    p = make_product(db, images=[f"/api/uploads/x{i}.jpg" for i in range(9)], image="/api/uploads/x0.jpg")
    r = c.post(f"/api/admin/products/{p.id}/images",
               files={"file": ("k.jpg", JPG, "image/jpeg")})
    assert r.status_code == 201
    assert len(r.json()["images"]) == 10


def test_bulk_upload_respects_remaining_slots(client):
    c, db = client
    p = make_product(db, images=[f"/api/uploads/x{i}.jpg" for i in range(8)], image="/api/uploads/x0.jpg")
    files = [("files", (f"n{i}.jpg", JPG, "image/jpeg")) for i in range(4)]
    r = c.post(f"/api/admin/products/{p.id}/images/bulk", files=files)
    assert r.status_code == 201
    body = r.json()
    assert body["_upload"]["added"] == 2
    assert len(body["_upload"]["rejected"]) == 2
    assert body["_upload"]["count"] == 10


# ---------------- главная / порядок / удаление ----------------

def test_set_main_moves_to_index_0(client):
    c, db = client
    p = make_product(db, images=["/u/a.jpg", "/u/b.jpg", "/u/c.jpg"], image="/u/a.jpg")
    r = c.post(f"/api/admin/products/{p.id}/images/main", json={"url": "/u/c.jpg"})
    assert r.status_code == 200
    body = r.json()
    assert body["images"][0] == "/u/c.jpg"
    assert body["image"] == "/u/c.jpg"
    assert set(body["images"]) == {"/u/a.jpg", "/u/b.jpg", "/u/c.jpg"}


def test_reorder_same_set_ok(client):
    c, db = client
    p = make_product(db, images=["/u/a.jpg", "/u/b.jpg", "/u/c.jpg"], image="/u/a.jpg")
    r = c.post(f"/api/admin/products/{p.id}/images/reorder",
               json={"images": ["/u/c.jpg", "/u/a.jpg", "/u/b.jpg"]})
    assert r.status_code == 200
    assert r.json()["images"] == ["/u/c.jpg", "/u/a.jpg", "/u/b.jpg"]
    assert r.json()["image"] == "/u/c.jpg"


def test_reorder_rejects_foreign_or_dup_or_missing(client):
    c, db = client
    p = make_product(db, images=["/u/a.jpg", "/u/b.jpg", "/u/c.jpg"], image="/u/a.jpg")
    base = f"/api/admin/products/{p.id}/images/reorder"
    assert c.post(base, json={"images": ["/u/a.jpg", "/u/b.jpg", "/u/x.jpg"]}).status_code == 400  # foreign
    assert c.post(base, json={"images": ["/u/a.jpg", "/u/b.jpg"]}).status_code == 400              # missing
    assert c.post(base, json={"images": ["/u/a.jpg", "/u/a.jpg", "/u/b.jpg", "/u/c.jpg"]}).status_code == 400  # dup


def test_delete_main_promotes_next(client):
    c, db = client
    p = make_product(db, images=["/u/a.jpg", "/u/b.jpg", "/u/c.jpg"], image="/u/a.jpg")
    r = c.request("DELETE", f"/api/admin/products/{p.id}/images", json={"url": "/u/a.jpg"})
    assert r.status_code == 200
    body = r.json()
    assert body["images"] == ["/u/b.jpg", "/u/c.jpg"]
    assert body["image"] == "/u/b.jpg"


# ---------------- карточка / резолвер ----------------

def test_to_card_contains_images():
    from tests.conftest import make_product as mk
    # используем отдельную сессию через фикстуру db не нужен: to_card чистый
    p = Product(title="iPhone", price=1000, images=["/u/a.jpg", "/u/b.jpg"], image="/u/a.jpg")
    card = p.to_card()
    assert "images" in card
    assert card["images"] == ["/u/a.jpg", "/u/b.jpg"]


def test_resolver_caps_at_ten(client):
    c, db = client
    p = make_product(db, images=[f"/u/{i}.jpg" for i in range(15)], image="/u/0.jpg")
    resolved = resolve_product_images(db, [p])
    assert len(resolved[p.id]["images"]) == 10
    assert resolved[p.id]["image"] == "/u/0.jpg"


def test_card_gets_effective_gallery(client):
    c, db = client
    p = make_product(db, images=["/u/a.jpg", "/u/b.jpg"], image="/u/a.jpg",
                     title="Zzz Unique Model", brand="ZzzBrand")
    r = c.get("/api/catalog/list?query=Zzz")
    assert r.status_code == 200
    cards = r.json()["cards"]
    mine = [x for x in cards if x["id"] == p.id]
    assert mine and mine[0]["images"] == ["/u/a.jpg", "/u/b.jpg"]


# ---------------- ZIP > 10 ----------------

def test_zip_over_limit_reports_excess(client):
    c, db = client
    make_product(db, sku="TESTSKUA", title="Test A", images=[], image=None)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("TESTSKUA.jpg", JPG)                 # main (order 0)
        for i in range(1, 12):                            # -1..-11 (11 файлов)
            zf.writestr(f"TESTSKUA-{i}.jpg", JPG)
    buf.seek(0)
    r = c.post("/api/admin/uploads/products/images-zip",
               files={"file": ("photos.zip", buf.read(), "application/zip")})
    assert r.status_code == 200
    body = r.json()
    matched = body["matched_products"][0]
    assert matched["images"] == 10                        # применены первые 10
    assert len(body["excess_images"]) == 2                # 2 сверх лимита — в отчёте
    p = db.query(Product).filter(Product.sku == "TESTSKUA").one()
    assert len(p.images) == 10


# ---------------- photo coverage endpoint ----------------

def test_photo_coverage_counts_and_filter(client):
    c, db = client
    make_product(db, title="A", images=["/u/a.jpg", "/u/b.jpg", "/u/c.jpg", "/u/d.jpg"], image="/u/a.jpg", brand="Ba")
    make_product(db, title="B", images=["/u/x.jpg"], image="/u/x.jpg", brand="Bb")
    make_product(db, title="C", images=[], image=None, brand="Bc")
    make_product(db, title="D", images=[], image="/assets/placeholders/smartphones.svg", brand="Bd")

    r = c.get("/api/admin/photo-coverage")
    assert r.status_code == 200
    body = r.json()
    s = body["summary"]
    assert s["total_active"] == 4
    assert s["no_photo"] == 2          # C и D (плейсхолдер = 0 эффективных)
    assert s["one_photo"] == 1
    assert s["four_plus"] == 1
    assert s["placeholder"] == 1       # D
    assert 0 <= s["coverage_pct"] <= 100

    # фильтр «без фото»
    only_none = c.get("/api/admin/photo-coverage?filter=no_photo").json()
    assert all(i["current_images"] == 0 for i in only_none["items"])
    assert only_none["total"] == 2
    # приоритет присутствует
    assert all("priority" in i for i in body["items"])
