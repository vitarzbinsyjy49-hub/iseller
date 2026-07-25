"""Download + validate photos for approved matches, and build a SKU-named ZIP.

Only runs for rows a human left approved (status in DOWNLOADABLE, no hard conflict).
Per image: HTTP 200 → Content-Type image → real signature/decode (Pillow) →
minimum resolution → SHA-256 dedup (within the product) → save. Files are named for
the existing iSeller ZIP import (``SKU.ext`` main, ``SKU-1.ext``… gallery), capped at
MAX_IMAGES. Nothing is hotlinked; external URLs are only recorded in the manifest.
"""
from __future__ import annotations

import csv
import hashlib
import io
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from PIL import Image

_IMG_MIN_INTERVAL = 0.3          # gentle spacing between image downloads
_last_fetch = 0.0

MAX_IMAGES = 10
MIN_SIDE = 400                                   # skip thumbnails / icons / logos
_FMT_EXT = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif"}
_FMT_MIME = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}
DOWNLOADABLE = {"exact", "verified", "approved", "likely"}
USER_AGENT = "iSeller-photo-coverage/1.0 (+admin backfill)"


class ValidationError(Exception):
    pass


def validate_image(data: bytes, *, min_side: int = MIN_SIDE) -> dict:
    """Decode + check a real raster image of sufficient size. Raises ValidationError."""
    if not data:
        raise ValidationError("empty body")
    try:
        im = Image.open(io.BytesIO(data))
        im.verify()                              # signature/structure check
        im = Image.open(io.BytesIO(data))        # re-open after verify to read size
        w, h = im.size
        fmt = (im.format or "").upper()
    except Exception as e:                        # noqa: BLE001
        raise ValidationError(f"not a decodable image ({type(e).__name__})")
    if fmt not in _FMT_EXT:
        raise ValidationError(f"unsupported format {fmt}")
    if max(w, h) < min_side:
        raise ValidationError(f"too small {w}x{h} (<{min_side})")
    return {"width": w, "height": h, "format": fmt,
            "ext": _FMT_EXT[fmt], "mime": _FMT_MIME[fmt]}


def _default_fetch(url: str) -> tuple[int, str, bytes]:
    global _last_fetch
    dt = time.monotonic() - _last_fetch
    if dt < _IMG_MIN_INTERVAL:
        time.sleep(_IMG_MIN_INTERVAL - dt)
    _last_fetch = time.monotonic()
    req = urllib.request.Request(_safe_url(url), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


def _safe_url(url: str) -> str:
    """Percent-encode the path/query so spaces and other literals in Rocketniks
    image filenames (e.g. 'air_15_m4_2 1.png') don't break the request."""
    p = urllib.parse.urlsplit(url)
    path = urllib.parse.quote(p.path, safe="/%")
    query = urllib.parse.quote(p.query, safe="=&%")
    return urllib.parse.urlunsplit((p.scheme, p.netloc, path, query, p.fragment))


def is_downloadable(rec) -> bool:
    return getattr(rec, "status", "") in DOWNLOADABLE and not getattr(rec, "conflicts", None) \
        and bool(getattr(rec, "images", None))


def download_record(rec, photos_dir: Path, *, fetch=_default_fetch, dry_run=False) -> list[dict]:
    """Validate (and unless dry_run, save) up to MAX_IMAGES for one record.
    Returns manifest rows."""
    rows: list[dict] = []
    seen_sha: set[str] = set()
    saved = 0
    for src in rec.images[:MAX_IMAGES + 5]:       # allow a few extra to survive dedup/reject
        if saved >= MAX_IMAGES:
            break
        try:
            status, ctype, data = fetch(src)
            if status != 200:
                raise ValidationError(f"http {status}")
            if "image" not in (ctype or "").lower() and ctype:
                raise ValidationError(f"content-type {ctype}")
            info = validate_image(data)
            sha = hashlib.sha256(data).hexdigest()
            if sha in seen_sha:
                continue                           # duplicate within this product
            seen_sha.add(sha)
            fname = f"{rec.sku}{info['ext']}" if saved == 0 else f"{rec.sku}-{saved}{info['ext']}"
            if not dry_run:
                (photos_dir / fname).write_bytes(data)
            saved += 1
            rows.append({
                "sku": rec.sku, "file_name": fname, "sha256": sha,
                "width": info["width"], "height": info["height"], "mime_type": info["mime"],
                "source_page_url": rec.source_url, "source_image_url": src,
                "match_score": rec.score, "approval_status": rec.status,
            })
        except Exception as e:   # noqa: BLE001 — record the reason and continue
            rows.append({
                "sku": rec.sku, "file_name": "", "sha256": "", "width": "", "height": "",
                "mime_type": "", "source_page_url": rec.source_url, "source_image_url": src,
                "match_score": rec.score, "approval_status": rec.status,
                "error": str(e)[:120],
            })
    return rows


MANIFEST_COLS = ["sku", "visual_group_id", "file_name", "sha256", "width", "height",
                 "mime_type", "source_page_url", "source_image_url", "match_score", "approval_status"]


def run_download(records, outdir: Path, *, dry_run=False, only_sku=None, fetch=_default_fetch) -> dict:
    outdir = Path(outdir)
    photos = outdir / "photos"
    photos.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []
    approved = [r for r in records if is_downloadable(r)
                and (only_sku is None or r.sku.lower() in only_sku)]
    for rec in approved:
        manifest.extend(download_record(rec, photos, fetch=fetch, dry_run=dry_run))

    # manifest CSV
    with open(outdir / "image_manifest.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=MANIFEST_COLS + ["error"])
        w.writeheader()
        for row in manifest:
            w.writerow({**{c: "" for c in MANIFEST_COLS + ["error"]}, **row})

    saved_files = [row["file_name"] for row in manifest if row.get("file_name")]
    zip_path = outdir / "AI_SELLER_ROCKETNIKS_VERIFIED.zip"
    if not dry_run and saved_files:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for fn in saved_files:
                z.write(photos / fn, arcname=fn)
    summary = {
        "approved_products": len(approved),
        "files": len(saved_files),
        "skus_with_photos": len({row["sku"] for row in manifest if row.get("file_name")}),
        "errors": len([row for row in manifest if row.get("error")]),
        "zip": str(zip_path) if (not dry_run and saved_files) else None,
        "dry_run": dry_run,
    }
    print("=== download ===")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    return summary
