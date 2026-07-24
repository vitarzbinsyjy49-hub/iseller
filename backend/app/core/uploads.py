"""Хранение загруженных изображений товаров (демо: локальный диск + Docker volume).

Файлы кладём в UPLOAD_DIR (по умолчанию /code/uploads, смонтирован как том,
чтобы переживать пересборку контейнера). Наружу раздаём через StaticFiles на
/api/uploads (см. main.py) — тот же origin, что и API, поэтому Caddy их проксирует.
"""
import os
import uuid
from pathlib import Path

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "/code/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

URL_PREFIX = "/api/uploads"
MAX_BYTES = 8 * 1024 * 1024  # 8 МБ на файл

# v5.4.0: единый лимит числа фото на товар/эффективную группу. Enforced на
# бэкенде во ВСЕХ путях (ручная загрузка, мультизагрузка, ZIP, импорт, reorder,
# resolver), а не только в UI.
MAX_PRODUCT_IMAGES = 10


def normalize_gallery(
    urls, *, main: str | None = None, limit: int = MAX_PRODUCT_IMAGES
) -> tuple[list[str], list[str]]:
    """Привести галерею к каноничному виду: без пустых, без дублей, главная —
    первой, не длиннее limit. Возвращает (images, excess): excess — то, что не
    влезло в лимит (для прозрачного отчёта, без «молчаливого» отбрасывания)."""
    ordered: list[str] = []
    if main:
        ordered.append(main)
    ordered.extend(urls or [])
    seen: set[str] = set()
    clean: list[str] = []
    for u in ordered:
        if not isinstance(u, str):
            continue
        u = u.strip()
        if not u or u in seen:
            continue
        seen.add(u)
        clean.append(u)
    return clean[:limit], clean[limit:]

# content-type -> расширение файла
_EXT = {
    "image/jpeg": ".jpg",
    "image/pjpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def is_allowed(content_type: str | None) -> bool:
    return (content_type or "").lower() in _EXT


def save_image(content_type: str, data: bytes) -> str:
    """Сохраняет байты картинки на диск, возвращает публичный URL /api/uploads/<name>."""
    ext = _EXT[content_type.lower()]
    name = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_DIR / name).write_bytes(data)
    return f"{URL_PREFIX}/{name}"


def delete_image(url: str) -> None:
    """Удаляет файл по его URL. Внешние URL (не /api/uploads/...) молча игнорирует."""
    if not url or not url.startswith(URL_PREFIX + "/"):
        return
    name = url.rsplit("/", 1)[-1]
    if not name:
        return
    try:
        (UPLOAD_DIR / name).unlink(missing_ok=True)
    except OSError:
        pass
