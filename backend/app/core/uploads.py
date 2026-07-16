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
