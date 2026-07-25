"""Download/validation tests — signature, min-resolution, SHA dedup, limit 10,
ZIP naming, dry-run. No network: a fake fetcher serves in-memory PNGs."""
import io
import os
import sys
import zipfile
from dataclasses import dataclass, field

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from scripts.rocketniks import download  # noqa: E402


def _png(w=800, h=800, color=(200, 30, 30)):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


@dataclass
class Rec:
    sku: str
    status: str = "likely"
    score: int = 80
    source_url: str = "http://api.rocketniks.ru/api/products/x"
    images: list = field(default_factory=list)
    conflicts: list = field(default_factory=list)


def make_fetch(mapping):
    def fetch(url):
        if url not in mapping:
            return 404, "", b""
        return mapping[url]
    return fetch


# ---------- validation ----------
def test_validate_rejects_non_image():
    with pytest.raises(download.ValidationError):
        download.validate_image(b"not-an-image")


def test_validate_rejects_thumbnail():
    with pytest.raises(download.ValidationError):
        download.validate_image(_png(100, 100), min_side=400)


def test_validate_accepts_full_size():
    info = download.validate_image(_png(1000, 1000))
    assert info["width"] == 1000 and info["mime"] == "image/png"


# ---------- dedup ----------
def test_sha256_dedup_within_product(tmp_path):
    same = _png(600, 600, (10, 10, 200))
    fetch = make_fetch({"a": (200, "image/png", same), "b": (200, "image/png", same),
                        "c": (200, "image/png", _png(600, 600, (0, 200, 0)))})
    rec = Rec("SKU1", images=["a", "b", "c"])
    rows = download.download_record(rec, tmp_path, fetch=fetch, dry_run=True)
    saved = [r for r in rows if r.get("file_name")]
    assert len(saved) == 2                       # b was a duplicate of a


# ---------- limit 10 ----------
def test_limit_10(tmp_path):
    imgs = {str(i): (200, "image/png", _png(500, 500, (i, i, i))) for i in range(15)}
    rec = Rec("CAP", images=list(imgs.keys()))
    rows = download.download_record(rec, tmp_path, fetch=make_fetch(imgs), dry_run=True)
    saved = [r for r in rows if r.get("file_name")]
    assert len(saved) == download.MAX_IMAGES == 10


# ---------- ZIP naming ----------
def test_zip_naming_main_and_gallery(tmp_path):
    imgs = {str(i): (200, "image/png", _png(500, 500, (i * 7, i, 50))) for i in range(3)}
    rec = Rec("APL-X", images=list(imgs.keys()))
    summary = download.run_download([rec], tmp_path, fetch=make_fetch(imgs))
    names = sorted(p.name for p in (tmp_path / "photos").iterdir())
    assert names == ["APL-X-1.png", "APL-X-2.png", "APL-X.png"]  # main has no suffix
    with zipfile.ZipFile(summary["zip"]) as z:
        assert set(z.namelist()) == {"APL-X.png", "APL-X-1.png", "APL-X-2.png"}


# ---------- dry-run writes nothing ----------
def test_dry_run_writes_no_files(tmp_path):
    imgs = {"a": (200, "image/png", _png())}
    rec = Rec("DRY", images=["a"])
    download.run_download([rec], tmp_path, dry_run=True, fetch=make_fetch(imgs))
    assert not any((tmp_path / "photos").iterdir())
    assert not (tmp_path / "AI_SELLER_ROCKETNIKS_VERIFIED.zip").exists()


# ---------- approval gate ----------
def test_review_and_conflict_not_downloaded(tmp_path):
    imgs = {"a": (200, "image/png", _png())}
    review = Rec("R1", status="review", images=["a"])
    conflicted = Rec("R2", status="likely", images=["a"], conflicts=["color x≠y"])
    rejected = Rec("R3", status="rejected", images=["a"])
    s = download.run_download([review, conflicted, rejected], tmp_path, dry_run=True,
                              fetch=make_fetch(imgs))
    assert s["approved_products"] == 0


# ---------- http error surfaced, not raised ----------
def test_http_error_recorded(tmp_path):
    rec = Rec("H", images=["missing"])
    rows = download.download_record(rec, tmp_path, fetch=make_fetch({}), dry_run=True)
    assert rows and rows[0].get("error") and "404" in rows[0]["error"]
