"""Rocketniks collector — discover + report + download for iSeller SKUs missing photos.

Pipeline (read-only until an explicit download):
    review-queue CSV  ->  --discover  ->  matches.json + review CSVs + report.md/html
                          --download   ->  validated photos + ZIP (SKU-named) + manifest

Modes:
    --discover   search the Public API, match, collect data (NO image download)
    --report     (re)write CSV/MD/HTML from an existing matches.json
    --download   download+validate photos for approved rows -> SKU-named ZIP
    --dry-run    with --download: validate everything but write nothing to the ZIP
    --limit N    process at most N products
    --sku S      process only this SKU (repeatable)
    --resume     reuse cache + skip products already in matches.json

Approval for --download comes from the review CSV: a row is downloadable if its
``approval`` is ``exact``/``verified``/``approved`` (``review``/``rejected`` are
never downloaded). ``exact`` still requires a human to have looked — see report.md.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from scripts.rocketniks import matcher  # noqa: E402
from scripts.rocketniks.client import RocketniksClient, absolute_image_url  # noqa: E402

MAX_IMAGES = 10
PRODUCT_IMG_MARK = "/images/products/"
DOWNLOADABLE = {"exact", "verified", "approved", "likely"}   # 'likely' opt-in; review/rejected never


# ---------------- input ----------------
def load_queue(path: str | Path) -> list[dict]:
    rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    out = []
    for r in rows:
        sku = (r.get("sku") or "").strip()
        title = (r.get("title") or "").strip()
        if sku and title:
            out.append({"sku": sku, "title": title, "category": (r.get("category") or "").strip()})
    return out


# ---------------- discovery ----------------
def build_queries(sku: str, title: str) -> list[str]:
    qs = []
    for q in (sku, matcher.normalize_query(title), _model_only(title)):
        q = (q or "").strip()
        if q and q not in qs:
            qs.append(q)
    return qs


def _model_only(title: str) -> str:
    """Model without colour — widens recall for colour-specific SKUs."""
    q = matcher.normalize_query(title)
    for c in matcher.signature(title).colors:
        q = q.replace(c, " ")
    # also strip the RU colour words that survive in EN titles rarely; keep it simple
    return matcher._WS.sub(" ", q).strip()


def gather_candidates(client: RocketniksClient, queries: list[str]) -> list[dict]:
    seen: dict[str, dict] = {}
    for q in queries:
        for p in client.search(q).get("products", []):
            url = p.get("url")
            if url and url not in seen:
                seen[url] = p
    return list(seen.values())


_SIZE_PREFIX = ("LARGE_", "MEDIUM_", "SMALL_")


def _img_id(url: str) -> str:
    """Canonical id of an image regardless of size variant (strip LARGE_/… prefix)."""
    b = url.rsplit("/", 1)[-1]
    for p in _SIZE_PREFIX:
        if b.startswith(p):
            return b[len(p):]
    return b


def _large(im: dict, base: str) -> str | None:
    if not isinstance(im, dict):
        return None
    rel = (im.get("sizes") or {}).get("large") or im.get("url") or ""
    if PRODUCT_IMG_MARK not in rel:              # exclude brand/category logos & service imgs
        return None
    return absolute_image_url(base, rel)


def _urls(items, base: str) -> list[str]:
    out = []
    for im in items or []:
        u = _large(im, base)
        if u and u not in out:
            out.append(u)
    return out


def _variant_slugs(detail: dict) -> list[str]:
    links = ((detail.get("variantsLinks") or {}).get("links") or {})
    return list(dict.fromkeys(links.values()))


def color_correct_gallery(client, detail: dict, base: str) -> list[str]:
    """Colour-specific gallery for one variant (ЧАСТЬ 4: разные цвета — разные
    галереи). Rocketniks shares ONE ``images`` pool across colours, so we take this
    variant's own ``vartiantImages`` (colour heroes) plus only the pool images that
    are NOT another colour's hero (i.e. colour-neutral detail shots)."""
    own = _urls(detail.get("vartiantImages"), base)
    own_ids = {_img_id(u) for u in own}
    pool = _urls(detail.get("images"), base)
    # collect other colours' hero images across sibling variants (cached fetches)
    other_hero_ids: set[str] = set()
    this_slug = detail.get("url")
    for slug in _variant_slugs(detail):
        if slug == this_slug:
            continue
        sd = client.product(slug)
        if not sd:
            continue
        for u in _urls(sd.get("vartiantImages"), base):
            other_hero_ids.add(_img_id(u))
    neutral = [u for u in pool if _img_id(u) not in (other_hero_ids - own_ids)]
    gallery: list[str] = []
    for u in own + neutral:                      # own colour heroes first
        if u not in gallery:
            gallery.append(u)
    return gallery[:MAX_IMAGES]


def _specs(detail: dict) -> dict:
    out: dict[str, str] = {}
    for g in detail.get("propertiesGroups", []) or []:
        for pr in (g.get("properties") or []):
            k, v = pr.get("name"), pr.get("value")
            if k and k not in out:
                out[str(k)] = v
    return out


@dataclass
class Record:
    sku: str
    title: str
    status: str
    score: int
    candidate_name: str = ""
    vendor_code: str = ""
    source_url: str = ""
    color: str = ""
    image_count: int = 0
    images: list[str] = field(default_factory=list)
    matched: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    soft_conflicts: list[str] = field(default_factory=list)
    product_data: dict = field(default_factory=dict)
    retrieved_at: str = ""


def discover_product(client: RocketniksClient, sku: str, title: str, base: str) -> Record:
    cands = gather_candidates(client, build_queries(sku, title))
    res = matcher.match_product(sku, title, cands)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if res.candidate is None:
        return Record(sku, title, "not_found", 0, matched=res.matched,
                      conflicts=res.conflicts, soft_conflicts=res.soft_conflicts, retrieved_at=now)
    # fetch detail of the chosen candidate to get structured colour + gallery + specs
    slug = res.candidate.get("url", "")
    detail = client.product(slug) or {}
    color = ((detail.get("color") or {}).get("name")) or ""
    # re-score with the structured colour (resolves 'colour unknown' review cases)
    refined = matcher.score_candidate(
        sku, title, {**res.candidate, "color": color, "name": detail.get("name") or res.candidate.get("name", "")}
    )
    # keep the better (non-rejected) of name-only vs detail-informed
    best = refined if _rank(refined.status) >= _rank(res.status) else res
    imgs = color_correct_gallery(client, detail, base)
    specs = _specs(detail)
    pdata = {
        "title_raw": detail.get("name") or "",
        "vendor_code": detail.get("vendorCode") or "",
        "brand": (detail.get("brand") or {}).get("name") or "",
        "color": color,
        "category": (detail.get("category") or {}).get("name") or "",
        "specs": specs,
        "source_url": _page_url(base, slug),
    }
    return Record(
        sku=sku, title=title, status=best.status, score=best.score,
        candidate_name=detail.get("name") or res.candidate.get("name", ""),
        vendor_code=detail.get("vendorCode") or res.candidate.get("vendorCode", ""),
        source_url=_page_url(base, slug), color=color,
        image_count=len(imgs), images=imgs,
        matched=best.matched, conflicts=best.conflicts, soft_conflicts=best.soft_conflicts,
        product_data=pdata, retrieved_at=now,
    )


_STATUS_RANK = {"rejected": 0, "not_found": 0, "review": 1, "likely": 2, "exact": 3}


def _rank(status: str) -> int:
    return _STATUS_RANK.get(status, 0)


def _page_url(base: str, slug: str) -> str:
    return f"{base}/api/products/{slug}" if slug else ""


# ---------------- outputs ----------------
def write_matches_json(records: list[Record], path: Path):
    path.write_text(json.dumps([asdict(r) for r in records], ensure_ascii=False, indent=1), encoding="utf-8")


def _csv(path: Path, header: list[str], rows: list[list]):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def write_reports(records: list[Record], outdir: Path):
    outdir.mkdir(parents=True, exist_ok=True)
    by = lambda st: [r for r in records if r.status in st]  # noqa: E731
    # matches (everything, with explanation + approval column primed with status)
    _csv(outdir / "rocketniks_matches.csv",
         ["sku", "title", "status", "score", "approval", "candidate", "vendor_code",
          "color", "image_count", "source_url", "matched", "conflicts", "soft_conflicts"],
         [[r.sku, r.title, r.status, r.score, r.status, r.candidate_name, r.vendor_code,
           r.color, r.image_count, r.source_url, " | ".join(r.matched),
           " | ".join(r.conflicts), " | ".join(r.soft_conflicts)] for r in records])
    _csv(outdir / "no_photos.csv", ["sku", "title", "status"],
         [[r.sku, r.title, r.status] for r in by({"not_found", "rejected"})])
    _csv(outdir / "needs_review.csv",
         ["sku", "title", "score", "candidate", "image_count", "conflicts", "soft_conflicts", "source_url"],
         [[r.sku, r.title, r.score, r.candidate_name, r.image_count,
           " | ".join(r.conflicts), " | ".join(r.soft_conflicts), r.source_url]
          for r in by({"review"})])
    _csv(outdir / "ready.csv",
         ["sku", "title", "status", "score", "candidate", "vendor_code", "color", "image_count", "source_url"],
         [[r.sku, r.title, r.status, r.score, r.candidate_name, r.vendor_code, r.color,
           r.image_count, r.source_url] for r in by({"exact", "likely"})])
    # product data
    _csv(outdir / "product_data.csv",
         ["sku", "title_raw", "brand", "color", "category", "source_url"],
         [[r.sku, r.product_data.get("title_raw", ""), r.product_data.get("brand", ""),
           r.product_data.get("color", ""), r.product_data.get("category", ""),
           r.product_data.get("source_url", "")] for r in records if r.product_data])
    (outdir / "product_data.json").write_text(
        json.dumps({r.sku: r.product_data for r in records if r.product_data}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    _write_report_md(records, outdir / "report.md")
    _write_report_html(records, outdir / "preview.html")


def _counts(records: list[Record]) -> dict:
    c = {"exact": 0, "likely": 0, "review": 0, "rejected": 0, "not_found": 0}
    for r in records:
        c[r.status] = c.get(r.status, 0) + 1
    return c


def _write_report_md(records: list[Record], path: Path):
    c = _counts(records)
    photos = sum(r.image_count for r in records if r.status in ("exact", "likely"))
    lines = [
        "# Rocketniks photo backfill — отчёт", "",
        f"Товаров: **{len(records)}**  ·  фото доступно (exact+likely): **{photos}**", "",
        "| Статус | Кол-во |", "|---|---|",
        *[f"| {k} | {c.get(k,0)} |" for k in ("exact", "likely", "review", "rejected", "not_found")],
        "", "## Ready (exact + likely) — можно применять", "",
        "| SKU | Статус | Фото | Кандидат | Цвет |", "|---|---|---|---|---|",
        *[f"| {r.sku} | {r.status} | {r.image_count} | {r.candidate_name} | {r.color} |"
          for r in records if r.status in ("exact", "likely")],
        "", "## Needs review — конфликт/неясно, решает человек", "",
        "| SKU | Фото | Конфликты | Кандидат |", "|---|---|---|---|",
        *[f"| {r.sku} | {r.image_count} | {'; '.join(r.conflicts + r.soft_conflicts) or '—'} | {r.candidate_name} |"
          for r in records if r.status == "review"],
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_report_html(records: list[Record], path: Path):
    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    cards = []
    for r in sorted(records, key=lambda r: (_STATUS_RANK.get(r.status, 0)), reverse=True):
        thumbs = "".join(f'<img loading="lazy" src="{esc(u)}">' for u in r.images[:MAX_IMAGES])
        badge = {"exact": "#128a3c", "likely": "#2b7", "review": "#b57e00",
                 "rejected": "#c0392b", "not_found": "#888"}.get(r.status, "#888")
        cards.append(f"""<div class="card">
  <div class="head"><b>{esc(r.sku)}</b><span class="badge" style="background:{badge}">{r.status} · {r.score}</span></div>
  <div class="ours">{esc(r.title)}</div>
  <div class="cand">→ {esc(r.candidate_name) or '—'} <span class="vc">{esc(r.vendor_code)}</span></div>
  <div class="meta">цвет: {esc(r.color) or '—'} · фото: {r.image_count}
    {('· конфликты: ' + esc('; '.join(r.conflicts + r.soft_conflicts))) if (r.conflicts or r.soft_conflicts) else ''}</div>
  <div class="thumbs">{thumbs}</div>
  {f'<a href="{esc(r.source_url)}" target="_blank">source</a>' if r.source_url else ''}
</div>""")
    c = _counts(records)
    html = f"""<!doctype html><meta charset="utf-8"><title>Rocketniks preview</title>
<style>
body{{font:14px/1.4 system-ui,Segoe UI,Roboto,sans-serif;margin:16px;background:#f6f7f9;color:#1b1f24}}
.sum{{margin-bottom:14px}} .sum span{{display:inline-block;margin-right:14px}}
.card{{background:#fff;border:1px solid #e5e8ec;border-radius:12px;padding:12px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.05)}}
.head{{display:flex;justify-content:space-between;align-items:center}}
.badge{{color:#fff;padding:2px 8px;border-radius:20px;font-size:12px}}
.ours{{font-weight:600;margin-top:4px}} .cand{{color:#444;margin-top:2px}} .vc{{color:#888;font-size:12px}}
.meta{{color:#666;font-size:12px;margin:4px 0}}
.thumbs{{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}}
.thumbs img{{width:96px;height:96px;object-fit:contain;background:#fafbfc;border:1px solid #eee;border-radius:8px}}
a{{font-size:12px;color:#2563eb}}
</style>
<h2>Rocketniks photo backfill — превью</h2>
<div class="sum"><b>{len(records)}</b> товаров ·
<span>exact {c['exact']}</span><span>likely {c['likely']}</span>
<span>review {c['review']}</span><span>rejected {c['rejected']}</span><span>not_found {c['not_found']}</span></div>
{''.join(cards)}
"""
    path.write_text(html, encoding="utf-8")


# ---------------- CLI ----------------
def run(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Rocketniks photo collector (read-only discovery + report).")
    ap.add_argument("--queue", default=None, help="review-queue CSV (sku,title,...)")
    ap.add_argument("--out", default=None, help="output dir (default artifacts/rocketniks/<date>)")
    ap.add_argument("--cache", default=None, help="API cache dir")
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--sku", action="append", default=[])
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args(argv)

    root = Path(__file__).resolve().parents[2]
    out = Path(args.out) if args.out else root / "artifacts" / "rocketniks" / datetime.now().strftime("%Y-%m-%d")
    out.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache) if args.cache else out / "cache"
    (out / "logs").mkdir(exist_ok=True)
    matches_path = out / "matches.json"

    client = RocketniksClient(cache)
    base = client.base

    if args.discover:
        queue = load_queue(args.queue) if args.queue else load_queue(root / "docs" / "photo-research" / "review_queue.csv")
        if args.sku:
            want = {s.lower() for s in args.sku}
            queue = [q for q in queue if q["sku"].lower() in want]
        if args.limit:
            queue = queue[: args.limit]
        done = {}
        if args.resume and matches_path.exists():
            done = {r["sku"]: r for r in json.loads(matches_path.read_text(encoding="utf-8"))}
        records: list[Record] = []
        for i, q in enumerate(queue, 1):
            if args.resume and q["sku"] in done:
                records.append(Record(**done[q["sku"]]))
                continue
            rec = discover_product(client, q["sku"], q["title"], base)
            records.append(rec)
            print(f"[{i}/{len(queue)}] {rec.sku:<28} {rec.status:<9} score={rec.score:<3} imgs={rec.image_count}")
        write_matches_json(records, matches_path)
        write_reports(records, out)
        (out / "logs" / "api_errors.json").write_text(
            json.dumps(client.errors, ensure_ascii=False, indent=1), encoding="utf-8")
        _summary(records, client)

    elif args.report:
        records = [Record(**r) for r in json.loads(matches_path.read_text(encoding="utf-8"))]
        write_reports(records, out)
        _summary(records, client)

    elif args.download:
        from scripts.rocketniks.download import run_download
        records = [Record(**r) for r in json.loads(matches_path.read_text(encoding="utf-8"))]
        run_download(records, out, dry_run=args.dry_run, only_sku={s.lower() for s in args.sku} or None)
    else:
        ap.print_help()
    return 0


def _summary(records, client):
    c = _counts(records)
    print("\n=== summary ===")
    print("  " + "  ".join(f"{k}={c.get(k,0)}" for k in ("exact", "likely", "review", "rejected", "not_found")))
    print(f"  photos available (exact+likely): {sum(r.image_count for r in records if r.status in ('exact','likely'))}")
    print(f"  api: cache_hits={client.stats['cache_hits']} network={client.stats['network']} errors={client.stats['errors']}")


if __name__ == "__main__":
    raise SystemExit(run())
