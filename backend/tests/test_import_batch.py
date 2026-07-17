"""Batch Import Center (v5.2): 20 обязательных сценариев."""
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.main import app
from app.models.product import Product
from app.services import import_center as ic
from app.services.import_jobs import JobError, get_job_store
from tests.conftest import make_product

ADMIN = "admin@test.local"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32   # валидная сигнатура PNG


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


def _csv(rows: list[dict]) -> bytes:
    if not rows:
        return b"sku,title,price\n"
    keys: list[str] = []
    for r in rows:                      # объединение колонок всех строк
        for k in r:
            if k not in keys:
                keys.append(k)
    lines = [",".join(keys)] + [",".join(str(r.get(k, "")) for k in keys) for r in rows]
    return "\n".join(lines).encode("utf-8")


def _xlsx(sheets: dict[str, list[list]]) -> bytes:
    from openpyxl import Workbook
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(title=name)
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _preview(client, files: list[tuple[str, bytes]], **fields):
    return client.post(
        "/api/admin/import/batch/preview",
        files=[("files", (n, d, "application/octet-stream")) for n, d in files],
        data={"mode": "create_or_update", "duplicate_policy": "error", **fields},
    )


# ---------- 1-2: объединение файлов ----------

def test_two_csv_one_job(client):
    r = _preview(client, [
        ("01.csv", _csv([{"sku": "A1", "title": "Товар A", "price": 1000}])),
        ("02.csv", _csv([{"sku": "B1", "title": "Товар B", "price": 2000}])),
    ])
    assert r.status_code == 200, r.text
    s = r.json()["summary"]
    assert s["data_files"] == 2 and s["create"] == 2 and s["errors"] == 0
    assert r.json()["job_id"]


def test_csv_xlsx_json_mix(client):
    xlsx = _xlsx({"products": [["sku", "title", "price"], ["X1", "Из XLSX", 500]]})
    r = _preview(client, [
        ("a.csv", _csv([{"sku": "C1", "title": "CSV", "price": 100}])),
        ("b.xlsx", xlsx),
        ("c.json", json.dumps([{"sku": "J1", "title": "JSON", "price": 300}]).encode()),
    ])
    assert r.status_code == 200
    assert r.json()["summary"]["create"] == 3


# ---------- 3: выбор листа XLSX ----------

def test_xlsx_products_sheet_preferred():
    data = _xlsx({
        "README": [["это", "не данные"]],
        "products": [["sku", "title", "price"], ["S1", "Товар", 900]],
    })
    rows, sheet = ic.rows_from_xlsx(data)
    assert sheet == "products"
    assert rows[0]["sku"] == "S1"


def test_xlsx_skips_service_sheets():
    data = _xlsx({
        "Сводка": [["итого", 5]],
        "Лист1": [["sku", "title", "price"], ["S2", "Товар2", 700]],
    })
    rows, sheet = ic.rows_from_xlsx(data)
    assert sheet == "Лист1" and rows[0]["sku"] == "S2"


# ---------- 4-5: дубли SKU между файлами ----------

def test_duplicate_sku_across_files_is_error(client):
    files = [
        ("01.csv", _csv([{"sku": "DUP1", "title": "Первый", "price": 100}])),
        ("02.csv", _csv([{"sku": "DUP1", "title": "Второй", "price": 200}])),
    ]
    r = _preview(client, files)
    body = r.json()
    assert body["summary"]["errors"] == 1
    assert body["summary"]["duplicates"] == 1
    dup_row = next(x for x in body["rows"] if x["errors"])
    assert "дубль SKU" in dup_row["errors"][0] and "01.csv" in dup_row["errors"][0]


def test_last_wins_transparent(client):
    files = [
        ("01.csv", _csv([{"sku": "DUP2", "title": "Старый", "price": 100}])),
        ("02.csv", _csv([{"sku": "DUP2", "title": "Новый", "price": 200}])),
    ]
    r = _preview(client, files, duplicate_policy="last_wins")
    body = r.json()
    assert body["summary"]["errors"] == 0
    assert body["duplicates"][0] == {"sku": "DUP2", "loser": "01.csv",
                                     "winner": "02.csv", "policy": "last_wins"}
    superseded = next(x for x in body["rows"] if x["action"] == "superseded")
    assert superseded["source_file"] == "01.csv"       # видно, кто проиграл
    winner = next(x for x in body["rows"] if x["action"] == "create")
    assert winner["changes"]["title"] == "Новый"


# ---------- 6-8: частичная семантика update ----------

def _confirm_ok(client, files, **fields) -> dict:
    r = _preview(client, files, **fields)
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    rc = client.post(f"/api/admin/import/batch/{job_id}/confirm")
    assert rc.status_code == 200, rc.text
    return rc.json()


def test_update_empty_stock_preserved(client, db):
    p = make_product(db, sku="KEEP1", title="Товар", price=5000, stock=7)
    _confirm_ok(client, [("u.csv", _csv([{"sku": "KEEP1", "title": "Товар", "price": 4000, "stock": ""}]))])
    db.refresh(p)
    assert p.stock == 7            # пустой stock НЕ обнулил остаток
    assert float(p.price) == 4000  # а цена обновилась


def test_explicit_zero_stock_applies(client, db):
    p = make_product(db, sku="ZERO1", stock=5)
    _confirm_ok(client, [("u.csv", _csv([{"sku": "ZERO1", "stock": 0}]))])
    db.refresh(p)
    assert p.stock == 0 and p.in_stock is False


def test_update_empty_is_active_not_reactivated(client, db):
    p = make_product(db, sku="OFF1", is_active=False)
    _confirm_ok(client, [("u.csv", _csv([{"sku": "OFF1", "price": 3000}]))])
    db.refresh(p)
    assert p.is_active is False    # пустой is_active не включил выключенный товар


# ---------- 9-11: фотографии и Import Pack ----------

def test_planned_sku_matches_photo(client):
    r = _preview(client, [
        ("p.csv", _csv([{"sku": "NEWPH1", "title": "Новый с фото", "price": 900}])),
        ("photos.zip", _zip({"NEWPH1_main.png": PNG, "NEWPH1-1.png": PNG})),
    ])
    body = r.json()
    assert body["summary"]["images_matched"] == 2
    assert body["images"][0]["sku"] == "NEWPH1"
    assert body["images"][0]["main_file"] == "NEWPH1_main.png"
    assert body["summary"]["products_without_photos"] == 0


def test_zip_image_only(client, db):
    make_product(db, sku="EXIST1", title="Существующий", price=100)
    result = _confirm_ok(client, [("photos.zip", _zip({"EXIST1.png": PNG}))])
    assert result["applied"] is True
    p = db.query(Product).filter(Product.sku == "EXIST1").one()
    assert p.images and p.image == p.images[0]


def test_import_pack_zip(client):
    pack = _zip({
        "products/01.csv": _csv([{"sku": "PACK1", "title": "Из пака", "price": 1500}]).decode().encode(),
        "images/PACK1_main.png": PNG,
        "manifest.json": json.dumps({"version": 1, "mode": "create_or_update",
                                     "duplicate_policy": "error"}).encode(),
        "README.txt": "инструкция".encode(),
    })
    r = _preview(client, [("AI_SELLER_IMPORT_PACK.zip", pack)])
    body = r.json()
    assert body["summary"]["create"] == 1
    assert body["summary"]["images_matched"] == 1
    assert any("manifest" in i["info"] for i in body["scan_info"])
    assert any("README" in s["file"] for s in body["scan_info"])   # README игнорирован с info


# ---------- 12-13: безопасность ZIP ----------

def test_zip_slip_blocked(client):
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as zf:
        zf.writestr("../../evil.png", PNG)
        zf.writestr("ok.png", PNG)
    r = _preview(client, [("z.zip", evil.getvalue())])
    body = r.json()
    assert any("zip-slip" in e["error"] for e in body["scan_errors"])
    assert body["summary"]["zip_images"] == 1          # только безопасный файл


def test_decompression_bomb_blocked(client, monkeypatch):
    monkeypatch.setattr(settings, "IMPORT_MAX_UNCOMPRESSED_BYTES", 100)
    r = _preview(client, [("bomb.zip", _zip({"big.png": PNG + b"\x00" * 500}))])
    assert r.status_code == 400
    assert "распакованный размер" in r.json()["detail"]


# ---------- 14-16: жизненный цикл job ----------

def test_foreign_admin_job_denied(client):
    job = get_job_store().create("other@admin", {"rows": [], "summary": {}}, {}, 600)
    r = client.get(f"/api/admin/import/batch/{job['job_id']}")
    assert r.status_code == 404                        # чужая job «не существует»


def test_expired_job_not_applied(client):
    job = get_job_store().create(ADMIN, {"rows": [], "summary": {}}, {}, -1)
    r = client.post(f"/api/admin/import/batch/{job['job_id']}/confirm")
    assert r.status_code == 404
    assert "истёк" in r.json()["detail"]


def test_double_confirm_idempotent(client, db):
    r = _preview(client, [("a.csv", _csv([{"sku": "IDEM1", "title": "Т", "price": 100}]))])
    job_id = r.json()["job_id"]
    first = client.post(f"/api/admin/import/batch/{job_id}/confirm")
    assert first.status_code == 200 and first.json()["status"] == "applied"
    second = client.post(f"/api/admin/import/batch/{job_id}/confirm")
    assert second.status_code == 200
    assert second.json().get("idempotent") is True
    assert db.query(Product).filter(Product.sku == "IDEM1").count() == 1  # не задвоился


# ---------- 17: транзакция ----------

def test_transaction_rollback(client, db, monkeypatch):
    import app.api.imports as imports_api

    def boom(db_, plan):
        db_.add(Product(title="Полфабрикат", price=1, sku="HALF1", source="import"))
        db_.flush()
        raise RuntimeError("имитация сбоя в середине применения")
    monkeypatch.setattr(imports_api.ic, "apply_product_plan", boom)

    r = _preview(client, [("a.csv", _csv([{"sku": "TX1", "title": "Т", "price": 100}]))])
    rc = client.post(f"/api/admin/import/batch/{r.json()['job_id']}/confirm")
    assert rc.status_code == 409
    assert "БД не изменена" in rc.json()["detail"]
    assert db.query(Product).filter(Product.sku.in_(["TX1", "HALF1"])).count() == 0


# ---------- 18-19: предупреждения и info ----------

def test_price_change_over_30pct_warns(client, db):
    make_product(db, sku="PW1", title="Т", price=100000)
    r = _preview(client, [("a.csv", _csv([{"sku": "PW1", "price": 50000}]))])
    row = next(x for x in r.json()["rows"] if x["sku"] == "PW1")
    assert any("цена меняется на 50%" in w for w in row["warnings"])


def test_unsupported_file_is_info(client):
    r = _preview(client, [
        ("a.csv", _csv([{"sku": "U1", "title": "Т", "price": 100}])),
        ("note.docx", b"not a real docx"),
    ])
    assert r.status_code == 200
    assert any("неподдерживаемый" in i["info"] for i in r.json()["scan_info"])


# ---------- 20: старые endpoints живы ----------

def test_legacy_single_file_endpoints(client, db):
    make_product(db, sku="OLD1", title="Старый", price=1000, stock=9)
    csv_data = _csv([{"sku": "OLD1", "price": 1200},
                     {"sku": "OLDNEW1", "title": "Новый", "price": 500}])
    rp = client.post("/api/admin/import/products/preview",
                     files={"file": ("f.csv", csv_data, "text/csv")})
    assert rp.status_code == 200
    assert rp.json()["created"] == 1 and rp.json()["updated"] == 1
    rc = client.post("/api/admin/import/products/confirm",
                     files={"file": ("f.csv", csv_data, "text/csv")})
    assert rc.status_code == 200 and rc.json()["applied"] is True
    p = db.query(Product).filter(Product.sku == "OLD1").one()
    assert float(p.price) == 1200
    assert p.stock == 9        # v5.2: старый endpoint тоже не обнуляет stock

    rz = client.post("/api/admin/uploads/products/images-zip",
                     files={"file": ("z.zip", _zip({"OLD1.png": PNG}), "application/zip")})
    assert rz.status_code == 200
    assert rz.json()["matched_products"][0]["sku"] == "OLD1"


# ---------- бонус: sha256 повреждённого staged-файла ----------

def test_staged_sha_mismatch(client):
    store = get_job_store()
    job = store.create(ADMIN, {"rows": [], "summary": {}}, {"a.zip": b"data"}, 600)
    # портим файл на диске
    from app.services.import_jobs import JOBS_DIR
    (JOBS_DIR / job["job_id"] / "staged" / "a.zip").write_bytes(b"tampered")
    with pytest.raises(JobError):
        store.read_staged(job["job_id"], ADMIN, "a.zip")