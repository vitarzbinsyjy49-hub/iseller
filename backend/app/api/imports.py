"""Import Center (v4): массовый импорт товаров и фото.

POST /api/admin/import/products/preview — разобрать файл (CSV/JSON/XLSX),
    провалидировать и показать, что будет создано/обновлено. БД не трогает.
POST /api/admin/import/products/confirm — тот же файл, применяет изменения.
POST /api/admin/uploads/products/images-zip — ZIP с фото, авто-матчинг по SKU.

Preview и confirm оба принимают файл (состояние на сервере не храним):
админка сначала шлёт файл на preview, показывает отчёт, по кнопке
«Импортировать» шлёт тот же файл на confirm. Просто и надёжно.

Правила импорта:
- sku обязателен (ключ матчинга);
- sku существует -> обновление, нет -> создание;
- старые товары не удаляются;
- price обязателен и валиден для новых товаров;
- stock пустой -> 0; is_active пустой -> true.
"""
import csv
import io
import json
import zipfile
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.uploads import MAX_PRODUCT_IMAGES, save_image
from app.db.session import get_db
from app.models.product import Product

router = APIRouter(prefix="/admin", tags=["admin-import"], dependencies=[Depends(get_current_admin)])

MAX_ROWS = 2000
MAX_FILE_BYTES = 20 * 1024 * 1024   # 20 МБ на файл импорта
MAX_ZIP_BYTES = 200 * 1024 * 1024   # 200 МБ на ZIP с фото

# v5.2: вся нормализация/парсинг файлов — в app/services/import_center.py
# (единая реализация для старых endpoints и batch-импорта).

async def _read_rows(file: UploadFile) -> list[dict]:
    """v5.2: разбор делегирован общему сервису import_center (одна реализация)."""
    from app.services import import_center as _ic
    data = await file.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 20 МБ")
    try:
        rows, _sheet = _ic.read_data_file(file.filename or "", data)
    except Exception as e:  # noqa: BLE001 — кривой файл = 400 с пояснением
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Не удалось разобрать файл: {str(e)[:200]}")
    if len(rows) > MAX_ROWS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Не больше {MAX_ROWS} строк за один импорт")
    if not rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "В файле нет строк с данными")
    return rows


def _analyze(rows: list[dict], db: Session) -> dict:
    """Общий проход preview/confirm: нормализация, валидация, план действий."""
    # Матчинг регистронезависимый: ключи — lower(sku)
    existing = {
        p.sku.lower(): p
        for p in db.execute(select(Product).where(Product.sku.is_not(None))).scalars()
    }
    plan: list[dict] = []
    report = {"total": len(rows), "created": 0, "updated": 0, "skipped": 0,
              "errors": [], "warnings": [], "items": []}
    seen_skus: set[str] = set()

    from app.services import import_center as _ic
    for i, raw in enumerate(rows):
        line = i + 2  # человеку удобнее номер строки файла (с учётом заголовка)
        # v5.2: единая нормализация с частичной семантикой — пустые поля при
        # update больше НЕ затирают stock/is_active существующего товара.
        sku_norm, changes, errors, warnings, _info = _ic.normalize_row(raw)
        item = None if sku_norm is None else {"sku": sku_norm, **changes}
        if item is None:
            report["skipped"] += 1
            report["errors"].append({"line": line, "sku": raw.get("sku"), "error": "; ".join(errors)})
            continue
        sku = item["sku"]
        if sku.lower() in seen_skus:
            report["skipped"] += 1
            report["errors"].append({"line": line, "sku": sku, "error": "дубль sku в этом же файле"})
            continue
        seen_skus.add(sku.lower())

        product = existing.get(sku.lower())
        action = "update" if product else "create"
        if action == "create":
            if not item.get("title"):
                errors.append("для нового товара нужен title")
            if item.get("price") is None:
                errors.append("для нового товара нужна корректная price")
            # дефолты только для НОВЫХ товаров (v5.2)
            item.setdefault("stock", 0)
            item.setdefault("is_active", True)
        if errors:
            report["skipped"] += 1
            report["errors"].append({"line": line, "sku": sku, "error": "; ".join(errors)})
            continue
        for w in warnings:
            report["warnings"].append({"line": line, "sku": sku, "warning": w})

        report[f"{action}d"] += 1
        report["items"].append({
            "line": line, "sku": sku, "action": action,
            "title": item.get("title") or (product.title if product else ""),
            "price": item.get("price") if item.get("price") is not None
                     else (float(product.price) if product else None),
            "stock": item.get("stock", 0),
        })
        plan.append({"action": action, "item": item, "product_id": product.id if product else None})

    report["plan"] = plan
    return report


def _apply_plan(plan: list[dict], db: Session) -> None:
    for step in plan:
        item = dict(step["item"])
        images = item.pop("images", None)
        if step["action"] == "create":
            product = Product(title=item["title"], price=item["price"], source="import")
        else:
            product = db.get(Product, step["product_id"])
            if product is None:
                continue
        for field, value in item.items():
            setattr(product, field, value)
        if images:
            product.images = images
            product.image = images[0]
        product.in_stock = (product.stock or 0) > 0
        if step["action"] == "create":
            db.add(product)
    db.commit()


@router.post("/import/products/preview")
async def import_preview(file: UploadFile = File(...), db: Session = Depends(get_db)):
    rows = await _read_rows(file)
    report = _analyze(rows, db)
    report.pop("plan")           # план — внутренняя кухня, наружу отдаём отчёт
    report["items"] = report["items"][:200]
    return report


@router.post("/import/products/confirm")
async def import_confirm(file: UploadFile = File(...), db: Session = Depends(get_db)):
    rows = await _read_rows(file)
    report = _analyze(rows, db)
    _apply_plan(report.pop("plan"), db)
    report["items"] = report["items"][:200]
    report["applied"] = True
    return report


# ==================== ZIP с фото: авто-матчинг по SKU ====================

_IMG_EXT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".webp": "image/webp", ".gif": "image/gif"}


def _resolve_image_sku(name: str, sku_index: dict[str, str]) -> tuple[str | None, int]:
    """v5.2.4.1: делегирует общему сервису; точный SKU важнее галерейного суффикса."""
    from app.services.import_center import resolve_filename_to_sku
    return resolve_filename_to_sku(name, sku_index)


@router.post("/uploads/products/images-zip")
async def upload_images_zip(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """ZIP с фото товаров. Матчинг: имя файла (до расширения) = SKU товара,
    суффиксы -1/-2/_main задают порядок. Первое фото становится главным."""
    data = await file.read()
    if len(data) > MAX_ZIP_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "ZIP больше 200 МБ")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл не является корректным ZIP-архивом")

    products = {
        (p.sku or "").lower(): p
        for p in db.execute(select(Product).where(Product.sku.is_not(None))).scalars()
    }
    # {lower: canonical} строим один раз на весь ZIP — без запроса на каждый файл
    sku_index = {low: (p.sku or "") for low, p in products.items()}
    # sku -> [(order, имя файла, content_type, данные)]
    matched: dict[str, list[tuple[int, str, str, bytes]]] = {}
    unmatched: list[str] = []
    errors: list[dict] = []

    for info in zf.infolist():
        if info.is_dir():
            continue
        base = PurePosixPath(info.filename.replace("\\", "/")).name
        if base.startswith(".") or base.startswith("__MACOSX"):
            continue
        ext = ("." + base.rsplit(".", 1)[-1].lower()) if "." in base else ""
        if ext not in _IMG_EXT:
            errors.append({"file": info.filename, "error": f"не изображение ({ext or 'без расширения'})"})
            continue
        if info.file_size > 8 * 1024 * 1024:
            errors.append({"file": info.filename, "error": "файл больше 8 МБ"})
            continue
        sku, order = _resolve_image_sku(base, sku_index)
        product = products.get(sku.lower()) if sku else None
        if product is None:
            unmatched.append(info.filename)
            continue
        try:
            payload = zf.read(info)
        except Exception as e:  # noqa: BLE001
            errors.append({"file": info.filename, "error": str(e)[:100]})
            continue
        matched.setdefault(product.sku, []).append((order, base, _IMG_EXT[ext], payload))

    matched_report = []
    excess_images: list[dict] = []
    for sku, files in matched.items():
        product = products[sku.lower()]
        files.sort(key=lambda f: f[0])
        # v5.4.0: применяем первые MAX_PRODUCT_IMAGES по текущему порядку сортировки,
        # лишние НЕ теряем молча — попадают в excess_images отчёта (и на диск не пишутся).
        keep = files[:MAX_PRODUCT_IMAGES]
        overflow = files[MAX_PRODUCT_IMAGES:]
        urls = [save_image(ctype, payload) for _, _, ctype, payload in keep]
        product.images = urls
        product.image = urls[0]
        matched_report.append({"sku": sku, "product_id": product.id,
                               "title": product.title, "images": len(urls)})
        for _, base, _ctype, _payload in overflow:
            excess_images.append({"sku": sku, "file": base, "reason": f"сверх лимита {MAX_PRODUCT_IMAGES}"})
    db.commit()

    without_images = [
        {"sku": p.sku, "id": p.id, "title": p.title}
        for p in products.values()
        if not p.images and (not p.image or p.image.startswith("/assets/placeholders/"))
    ]
    return {
        "matched_products": matched_report,
        "unmatched_images": unmatched,
        "excess_images": excess_images,   # v5.4.0: фото сверх лимита 10 (не применены)
        "products_without_images": without_images[:100],
        "errors": errors,
    }


# ==================== Загрузка одной картинки (баннеры/категории/медиа) ====================

@router.post("/uploads/image", status_code=status.HTTP_201_CREATED)
async def upload_single_image(file: UploadFile = File(...)):
    """Универсальная загрузка картинки: вернёт URL для баннера/категории/товара."""
    from app.core.uploads import MAX_BYTES, is_allowed
    if not is_allowed(file.content_type):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Только изображения: jpg, png, webp, gif")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    return {"url": save_image(file.content_type, data)}


# ============================================================
# Batch Import Center (v5.2): пакетный импорт с job-жизненным циклом
# preview -> job(TTL 30 мин) -> confirm(идемпотентный) / cancel
# ============================================================
import logging as _logging
import time as _time
from typing import Annotated

from fastapi import Form

from app.core.config import settings
from app.models.audit import AuditLog
from app.services import import_center as ic
from app.services.import_jobs import JobError, get_job_store, public_job_view

_batch_logger = _logging.getLogger("techshop.import.batch")

_MODES = {"create_or_update", "update_only", "create_only"}
_DUP_POLICIES = {"error", "last_wins"}


def _audit_event(db: Session, admin: str, action: str, detail: str) -> None:
    try:
        db.add(AuditLog(actor=f"admin:{admin}", action=action, detail=detail[:500]))
        db.commit()
    except Exception:  # noqa: BLE001 — аудит не должен ронять импорт
        db.rollback()
        _batch_logger.exception("audit event failed: %s", action)


@router.post("/import/batch/preview")
async def batch_preview(
    files: list[UploadFile] = File(...),
    mode: Annotated[str, Form()] = "create_or_update",
    duplicate_policy: Annotated[str, Form()] = "error",
    admin: str = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Пакетный preview: CSV/JSON/XLSX/ZIP (фото и/или Import Pack).
    БД не меняется, фото в постоянное хранилище не сохраняются."""
    if mode not in _MODES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"mode должен быть одним из {sorted(_MODES)}")
    if duplicate_policy not in _DUP_POLICIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"duplicate_policy: {sorted(_DUP_POLICIES)}")
    if len(files) > settings.IMPORT_MAX_FILES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Не больше {settings.IMPORT_MAX_FILES} файлов")
    if not files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файлы не переданы")

    data_files: list[dict] = []      # {"name", "rows", "sheet"}
    image_entries: list[ic.ZipEntry] = []
    staged: dict[str, bytes] = {}    # имя -> байты (для confirm без повторной загрузки)
    scan_info: list[dict] = []
    scan_errors: list[dict] = []
    total_rows = 0

    for up in files:
        name = (up.filename or "file").replace("\\", "/").split("/")[-1]
        payload = await up.read()
        low = name.lower()
        if low.endswith(".zip"):
            if len(payload) > settings.IMPORT_MAX_ZIP_BYTES:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"ZIP {name} больше лимита")
            try:
                scan = ic.scan_zip(payload)
            except ValueError as e:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{name}: {e}")
            manifest = scan.manifest or {}
            if manifest:
                m_mode = manifest.get("mode")
                if m_mode in _MODES:
                    mode = m_mode
                m_dup = manifest.get("duplicate_policy")
                if m_dup in _DUP_POLICIES:
                    duplicate_policy = m_dup
                scan_info.append({"file": name, "info": "manifest.json применён (mode/duplicate_policy)"})
            # data-файлы внутри Import Pack
            for inner_name, inner_data in scan.data_files:
                try:
                    rows, sheet = ic.read_data_file(inner_name, inner_data)
                except ValueError as e:
                    scan_errors.append({"file": f"{name}/{inner_name}", "error": str(e)[:200]})
                    continue
                total_rows += len(rows)
                data_files.append({"name": inner_name, "rows": rows, "sheet": sheet})
                staged[inner_name] = inner_data
            image_entries.extend(scan.images)
            if scan.images:
                staged[name] = payload   # весь ZIP стейджим один раз
            scan_info.extend(scan.skipped)
            scan_errors.extend(scan.errors)
        elif low.endswith(ic.DATA_EXTENSIONS) or low.endswith(".txt"):
            if len(payload) > settings.IMPORT_MAX_DATA_FILE_BYTES:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Файл {name} больше 20 МБ")
            try:
                rows, sheet = ic.read_data_file(name, payload)
            except ValueError as e:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{name}: {str(e)[:200]}")
            total_rows += len(rows)
            data_files.append({"name": name, "rows": rows, "sheet": sheet})
            staged[name] = payload
        else:
            scan_info.append({"file": name, "info": "неподдерживаемый файл — игнорирован"})

    if total_rows > settings.IMPORT_MAX_TOTAL_ROWS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Суммарно не больше {settings.IMPORT_MAX_TOTAL_ROWS} строк")
    if not data_files and not image_entries:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "В пакете нет данных или изображений")

    plan = ic.build_batch_plan(db, data_files, image_entries,
                               mode=mode, duplicate_policy=duplicate_policy)
    plan["scan_info"] = scan_info
    plan["scan_errors"] = scan_errors

    job = get_job_store().create(admin, plan, staged, settings.IMPORT_JOB_TTL_SECONDS)
    _audit_event(db, admin, "import_batch_preview",
                 f"job:{job['job_id']} files:{len(files)} rows:{plan['summary']['rows_total']} "
                 f"create:{plan['summary']['create']} update:{plan['summary']['update']}")
    return {"job_id": job["job_id"], "expires_at": job["expires_at"], **plan}


@router.get("/import/batch/{job_id}")
async def batch_get(job_id: str, admin: str = Depends(get_current_admin)):
    try:
        return public_job_view(get_job_store().get(job_id, admin))
    except JobError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))


@router.delete("/import/batch/{job_id}")
async def batch_cancel(job_id: str, admin: str = Depends(get_current_admin),
                       db: Session = Depends(get_db)):
    try:
        get_job_store().delete(job_id, admin)
    except JobError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))
    _audit_event(db, admin, "import_batch_cancel", f"job:{job_id}")
    return {"job_id": job_id, "status": "cancelled"}


@router.post("/import/batch/{job_id}/confirm")
async def batch_confirm(job_id: str, admin: str = Depends(get_current_admin),
                        db: Session = Depends(get_db)):
    """Применить ранее previewed план. Новых файлов не принимает.
    Товары — одной транзакцией; фото — после товаров, с отчётом по ошибкам."""
    store = get_job_store()
    try:
        job = store.get(job_id, admin)
    except JobError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))

    if job["status"] == "applied":
        # идемпотентный повторный confirm: возвращаем сохранённый результат
        return {**public_job_view(job), "idempotent": True}
    if job["status"] != "previewed":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Job в статусе {job['status']}")

    plan = job["normalized_plan"]
    blocking = [e for e in plan["rows"] if e["errors"]]
    if blocking:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"В плане {len(blocking)} строк с ошибками — confirm запрещён")

    # SHA-256 staged-файлов проверяется в read_staged; заново собираем фото из ZIP
    image_entries: list[ic.ZipEntry] = []
    for name in job["files"]:
        if name.lower().endswith(".zip"):
            try:
                data = store.read_staged(job_id, admin, name)
                image_entries.extend(ic.scan_zip(data).images)
            except (JobError, ValueError) as e:
                raise HTTPException(status.HTTP_409_CONFLICT, f"Staged-файл повреждён: {e}")

    # --- 1) товары: одна транзакция, всё или ничего ---
    t0 = _time.monotonic()
    try:
        sku_to_id = ic.apply_product_plan(db, plan)
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _batch_logger.exception("batch confirm failed, rolled back")
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Импорт отменён, БД не изменена: {str(e)[:200]}")

    # --- 2) фото: по товарам, ошибки отдельных файлов не откатывают товары ---
    # Матчинг с планом job И с уже существующими SKU (image-only ZIP без data-файлов)
    all_sku_to_id = dict(sku_to_id)
    for p in db.execute(select(Product).where(Product.sku.is_not(None))).scalars():
        all_sku_to_id.setdefault(p.sku, p.id)
    image_report: list[dict] = []
    image_errors: list[dict] = []
    matched_paths: dict[str, list[ic.ZipEntry]] = {}
    # индекс строится один раз: раньше на каждый файл шёл линейный скан каталога
    sku_index = ic.build_sku_index(list(all_sku_to_id))
    for img in image_entries:
        canon, _order = ic.resolve_filename_to_sku(img.name, sku_index)
        if canon is not None:
            matched_paths.setdefault(canon, []).append(img)
    excess_images: list[dict] = []
    for sku, imgs in matched_paths.items():
        try:
            imgs.sort(key=lambda im: ic.resolve_filename_to_sku(im.name, sku_index)[1])
            keep, overflow = imgs[:MAX_PRODUCT_IMAGES], imgs[MAX_PRODUCT_IMAGES:]
            urls = [save_image(im.content_type, im.data) for im in keep]
            product = db.get(Product, all_sku_to_id[sku])
            if product is not None:
                product.images = urls
                product.image = urls[0]
            db.commit()
            image_report.append({"sku": sku, "matched_images": len(urls),
                                 "main_file": keep[0].name, "files": [im.name for im in keep]})
            for im in overflow:
                excess_images.append({"sku": sku, "file": im.name, "reason": f"сверх лимита {MAX_PRODUCT_IMAGES}"})
        except Exception as e:  # noqa: BLE001
            db.rollback()
            image_errors.append({"sku": sku, "error": str(e)[:200]})

    report = {
        "applied": True,
        "partial": bool(image_errors),
        "summary": plan["summary"],
        "images_applied": image_report,
        "image_errors": image_errors,
        "excess_images": excess_images,   # v5.4.0: фото сверх лимита 10 (не применены)
        "took_ms": int((_time.monotonic() - t0) * 1000),
    }
    store.mark_applied(job_id, admin, report)
    _audit_event(db, admin, "import_batch_confirm",
                 f"job:{job_id} create:{plan['summary']['create']} "
                 f"update:{plan['summary']['update']} images:{len(image_report)} "
                 f"image_errors:{len(image_errors)}")
    return {"job_id": job_id, "status": "applied", **report}


# ============================================================
# MODEL_COLOR: галерея на группу модель+цвет (v5.2.6)
# ZIP с manifest.json (matchMode=model_color) + фото. Галерея назначается ВСЕМ
# вариантам модели одного цвета, а не одному SKU. Preview и confirm принимают
# один и тот же ZIP (без job-состояния на сервере).
# ============================================================


@router.post("/import/image-groups/preview")
async def image_groups_preview(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Dry-run: распознанные группы модель+цвет, ключи, затрагиваемые варианты
    (id/sku), отсутствующие файлы, конфликты. БД и хранилище не трогаются."""
    data = await file.read()
    if len(data) > MAX_ZIP_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "ZIP больше 200 МБ")
    try:
        scan = ic.scan_zip(data)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if not ic.normalize_group_specs(scan.manifest or {}):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Нужен manifest.json с matchMode=model_color (или image_groups[])")
    plan = ic.plan_image_group_import(db, scan.manifest, {img.name for img in scan.images})
    plan["scan_errors"] = scan.errors
    plan["scan_skipped"] = scan.skipped
    return plan


@router.post("/import/image-groups/confirm")
async def image_groups_confirm(file: UploadFile = File(...),
                               admin: str = Depends(get_current_admin),
                               db: Session = Depends(get_db)):
    """Тот же ZIP: сохраняет фото валидных групп и создаёт/обновляет их галереи.
    Товары не изменяются — фото подтягиваются resolver'ом по image_group_key."""
    data = await file.read()
    if len(data) > MAX_ZIP_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "ZIP больше 200 МБ")
    try:
        scan = ic.scan_zip(data)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if not ic.normalize_group_specs(scan.manifest or {}):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нужен manifest.json (matchMode=model_color)")
    plan = ic.plan_image_group_import(db, scan.manifest, {img.name for img in scan.images})
    by_name = {img.name: img for img in scan.images}
    needed = {f for g in plan["groups"] if not g["errors"] for f in g["present"]}
    url_by_filename = {
        name: save_image(by_name[name].content_type, by_name[name].data)
        for name in needed if name in by_name
    }
    result = ic.apply_image_group_import(db, plan, url_by_filename)
    _audit_event(db, admin, "import_image_groups",
                 f"groups:{result['groups_applied']} variants:{plan['summary']['variants_affected']}")
    return {"applied": True, "summary": plan["summary"], **result, "groups": plan["groups"]}
