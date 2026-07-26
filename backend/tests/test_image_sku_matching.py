"""v5.2.4.1 — точное сопоставление имени файла с SKU.

Регрессия, которую закрывают эти тесты: числовой хвост реального SKU
принимался за номер кадра галереи. 'APL-APD-4-2024.jpg' читался как
('APL-APD-4', 2024), а 'APL-APD-4-2024-2.jpg' — как ('APL-APD-4-2024', 2),
из-за чего фото ANC-версии AirPods 4 ушло обычным AirPods 4.
"""
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.main import app
from app.models.product import Product
from app.services import import_center as ic
from tests.conftest import make_product

ADMIN = "admin@test.local"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def resolve(name: str, skus):
    return ic.resolve_filename_to_sku(name, ic.build_sku_index(skus))


# ---------- 1: точный SKU с числовым хвостом ----------

def test_exact_numeric_sku():
    assert resolve("APL-APD-4-2024-2.jpg", {"APL-APD-4-2024-2"}) == ("APL-APD-4-2024-2", 0)


# ---------- 2: точный SKU, оканчивающийся годом ----------

def test_exact_year_sku():
    assert resolve("APL-APD-4-2024.jpg", {"APL-APD-4-2024"}) == ("APL-APD-4-2024", 0)


# ---------- 3: явный _main ----------

def test_explicit_main():
    assert resolve("APL-APD-4-2024-2_main.jpg", {"APL-APD-4-2024-2"}) == ("APL-APD-4-2024-2", 0)
    assert resolve("APL-APD-4-2024-2-main.jpg", {"APL-APD-4-2024-2"}) == ("APL-APD-4-2024-2", 0)


# ---------- 4: настоящая галерея ----------

def test_real_gallery():
    assert resolve("MDHF4-2.jpg", {"MDHF4"}) == ("MDHF4", 2)
    assert resolve("MDHF4_3.jpg", {"MDHF4"}) == ("MDHF4", 3)


# ---------- 5: приоритет точного SKU при коллизии ----------

def test_collision_priority_exact_wins():
    skus = {"REAL-SKU", "REAL-SKU-2"}
    assert resolve("REAL-SKU-2.jpg", skus) == ("REAL-SKU-2", 0)
    assert resolve("REAL-SKU-2_main.jpg", skus) == ("REAL-SKU-2", 0)
    # галерея самого REAL-SKU по-прежнему доступна через другой индекс
    assert resolve("REAL-SKU-3.jpg", skus) == ("REAL-SKU", 3)


# ---------- 6: галерея только если точного SKU нет ----------

def test_gallery_only_if_exact_absent():
    assert resolve("REAL-SKU-2.jpg", {"REAL-SKU"}) == ("REAL-SKU", 2)


# ---------- 7: неизвестный SKU ----------

def test_unknown_unmatched():
    assert resolve("UNKNOWN-2.jpg", {"REAL-SKU"}) == (None, 0)
    assert resolve("UNKNOWN.jpg", {"REAL-SKU"}) == (None, 0)


# ---------- 8: большой числовой суффикс не является индексом ----------

def test_large_suffix_not_gallery_index():
    # 2024 > MAX_GALLERY_INDEX -> не индекс; точного SKU нет -> unmatched
    assert resolve("APL-APD-4-2024.jpg", {"APL-APD-4"}) == (None, 0)
    assert resolve("APL-APD-4-2025.jpg", {"APL-APD-4"}) == (None, 0)
    assert resolve("APL-APD-4-2026.jpg", {"APL-APD-4"}) == (None, 0)
    # граница диапазона
    assert resolve("SKU-20.jpg", {"SKU"}) == ("SKU", 20)
    assert resolve("SKU-21.jpg", {"SKU"}) == (None, 0)


# ---------- 9: регистронезависимость с сохранением канонического SKU ----------

def test_case_insensitive_keeps_canonical():
    assert resolve("apl-apd-4-2024-2.JPG", {"APL-APD-4-2024-2"}) == ("APL-APD-4-2024-2", 0)
    assert resolve("mdhf4-2.png", {"MDHF4"}) == ("MDHF4", 2)
    assert resolve("MDHF4_MAIN.jpg", {"MDHF4"}) == ("MDHF4", 0)


def test_candidates_are_pure_and_ordered():
    """parse_filename_candidates не ходит в БД и отдаёт exact первым."""
    assert ic.parse_filename_candidates("REAL-SKU-2.jpg") == [("REAL-SKU-2", 0), ("REAL-SKU", 2)]
    assert ic.parse_filename_candidates("X_main.jpg") == [("X", 0)]
    assert ic.parse_filename_candidates("A-2024.jpg") == [("A-2024", 0)]


# ---------- 10: ZIP preview с реальными конфликтными именами ----------

@pytest.fixture()
def client(db):
    def override_db():
        yield db
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: ADMIN
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, b in files.items():
            z.writestr(n, b)
    return buf.getvalue()


def test_zip_preview_conflicting_names(client, db):
    """Оба AirPods существуют; каждый файл должен уйти своему владельцу."""
    make_product(db, sku="APL-APD-4-2024", title="AirPods 4 (2024)", price=1000)
    make_product(db, sku="APL-APD-4-2024-2", title="AirPods 4 (2024) ANC", price=1200)

    r = client.post(
        "/api/admin/import/batch/preview",
        files=[("files", ("photos.zip", _zip({
            "APL-APD-4-2024-2_main.png": PNG,
            "APL-APD-4-2024_main.png": PNG,
        }), "application/zip"))],
    )
    assert r.status_code == 200, r.text
    by_sku = {i["sku"]: i for i in r.json()["images"]}
    assert set(by_sku) == {"APL-APD-4-2024", "APL-APD-4-2024-2"}
    assert by_sku["APL-APD-4-2024-2"]["main_file"] == "APL-APD-4-2024-2_main.png"
    assert by_sku["APL-APD-4-2024"]["main_file"] == "APL-APD-4-2024_main.png"


def test_zip_preview_bare_numeric_sku_goes_to_owner(client, db):
    """Файл без _main, но с точным числовым SKU, не должен уходить базовому SKU."""
    make_product(db, sku="APL-APD-4-2024", title="AirPods 4 (2024)", price=1000)
    make_product(db, sku="APL-APD-4-2024-2", title="AirPods 4 (2024) ANC", price=1200)

    r = client.post(
        "/api/admin/import/batch/preview",
        files=[("files", ("photos.zip", _zip({"APL-APD-4-2024-2.png": PNG}), "application/zip"))],
    )
    assert r.status_code == 200, r.text
    imgs = r.json()["images"]
    assert len(imgs) == 1
    assert imgs[0]["sku"] == "APL-APD-4-2024-2"   # до фикса уходило на APL-APD-4-2024


def test_zip_apply_binds_to_exact_sku(client, db):
    """Сквозная проверка: применение ZIP кладёт снимок ровно тому SKU."""
    make_product(db, sku="APL-APD-4-2024", title="AirPods 4 (2024)", price=1000, image=None, images=[])
    make_product(db, sku="APL-APD-4-2024-2", title="AirPods 4 (2024) ANC", price=1200, image=None, images=[])

    r = client.post(
        "/api/admin/uploads/products/images-zip",
        files=[("file", ("photos.zip", _zip({"APL-APD-4-2024-2.png": PNG}), "application/zip"))],
    )
    assert r.status_code == 200, r.text
    anc = db.query(Product).filter(Product.sku == "APL-APD-4-2024-2").one()
    plain = db.query(Product).filter(Product.sku == "APL-APD-4-2024").one()
    assert anc.image, "снимок должен быть у ANC-версии"
    assert not plain.image, "обычная версия не должна получить чужой снимок"
