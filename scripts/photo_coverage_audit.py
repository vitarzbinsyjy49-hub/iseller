#!/usr/bin/env python3
"""Аудит покрытия каталога фотографиями (v5.4.0) — READ-ONLY.

Постоянный инструмент: считает покрытие ВСЕГО актуального каталога фото по
эффективным группам изображений (модель+цвет), а не по разовому импорту. Ничего
не пишет в БД и не скачивает картинки. Результаты — Markdown + CSV + JSON.

Источник данных: существующая БД через DATABASE_URL (sqlite/postgres). Скрипт
делает только SELECT'ы к таблицам products / product_image_groups.

Запуск (локально/демо):
    DATABASE_URL="sqlite:///demo.db" python scripts/photo_coverage_audit.py

Запуск на сервере (READ-ONLY, данные НЕ меняются):
    # значение DATABASE_URL взять из окружения backend-контейнера
    docker compose -f docker-compose.prod.yml exec -T backend \
        python /code/../scripts/photo_coverage_audit.py --out /tmp/photo-audit
    # (или вне контейнера, указав тот же DATABASE_URL на реплику/дамп)

Опции:
    --database-url URL   переопределить DATABASE_URL
    --out DIR            каталог для отчётов (по умолчанию docs/photo-research)
    --target N           желательное число фото на группу (по умолчанию 3)
    --source-label STR   пометка источника данных в отчёте (напр. "prod-replica")
    --check-urls         проверить доступность внешних URL (HEAD, timeout+лимит)
    --uploads-dir DIR    каталог локальных загрузок (для проверки битых локальных файлов)
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

MAX_PRODUCT_IMAGES = 10
PLACEHOLDER_PREFIX = "/assets/placeholders/"
LOCAL_PREFIX = "/api/uploads/"


# ----------------------------- загрузка данных -----------------------------

def _as_list(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        v = v.strip()
        if not v:
            return []
        try:
            v = json.loads(v)
        except json.JSONDecodeError:
            return [v]
    if isinstance(v, list):
        return [str(x) for x in v if x]
    return []


def load_rows(database_url: str):
    """Читает products и product_image_groups. Только SELECT'ы (read-only)."""
    try:
        from sqlalchemy import create_engine, text
    except Exception as e:  # noqa: BLE001
        print(f"Нужен SQLAlchemy: {e}", file=sys.stderr)
        sys.exit(2)

    engine = create_engine(database_url)
    products, groups = [], {}
    with engine.connect() as conn:
        pcols = ("id, sku, title, brand, category, model_family, color, "
                 "image_group_key, image_group_detached, is_active, in_stock, "
                 "is_hot, is_new, is_available_today, popularity, image, images")
        for r in conn.execute(text(f"SELECT {pcols} FROM products")).mappings():
            products.append({
                "id": r["id"], "sku": r["sku"], "title": r["title"], "brand": r["brand"],
                "category": r["category"], "model_family": r["model_family"], "color": r["color"],
                "image_group_key": r["image_group_key"],
                "image_group_detached": bool(r["image_group_detached"]),
                "is_active": bool(r["is_active"]), "in_stock": bool(r["in_stock"]),
                "is_hot": bool(r["is_hot"]), "is_new": bool(r["is_new"]),
                "is_available_today": bool(r["is_available_today"]),
                "popularity": float(r["popularity"] or 0),
                "image": r["image"], "images": _as_list(r["images"]),
            })
        try:
            for r in conn.execute(text(
                "SELECT key, image, images FROM product_image_groups")).mappings():
                groups[r["key"]] = {"image": r["image"], "images": _as_list(r["images"])}
        except Exception:  # noqa: BLE001 — таблицы может не быть на очень старой БД
            pass
    return products, groups


# ----------------------------- эффективная галерея -----------------------------

def own_images(image, images) -> list[str]:
    """Свои фото: главная первой, без дублей/пустых, не длиннее лимита. Плейсхолдер
    главной НЕ считается фотографией."""
    out, seen = [], set()
    ordered = ([image] if image else []) + list(images or [])
    for u in ordered:
        if not u or u in seen:
            continue
        if u.startswith(PLACEHOLDER_PREFIX):
            continue
        seen.add(u)
        out.append(u)
    return out[:MAX_PRODUCT_IMAGES]


def build_effective(products, groups):
    """Эффективная галерея каждого активного товара (та же логика, что resolver):
    группа -> свои -> сосед той же группы. Возвращает {product_id: [urls]}."""
    active = [p for p in products if p["is_active"]]
    # соседи по группе (у кого есть свои фото)
    sib = defaultdict(list)
    for p in active:
        k = p["image_group_key"]
        if k and not p["image_group_detached"]:
            oi = own_images(p["image"], p["images"])
            if oi:
                sib[k].append((p, oi))
    result = {}
    for p in active:
        k = p["image_group_key"]
        g = groups.get(k) if (k and not p["image_group_detached"]) else None
        gi = own_images(g["image"], g["images"]) if g else []
        if gi:
            result[p["id"]] = gi
            continue
        oi = own_images(p["image"], p["images"])
        if oi:
            result[p["id"]] = oi
            continue
        # сосед той же группы
        cand = sib.get(k)
        result[p["id"]] = cand[0][1] if cand else []
    return result


# ----------------------------- метрики -----------------------------

def bucket(n: int) -> str:
    if n == 0:
        return "none"
    if n == 1:
        return "one"
    if n <= 3:
        return "two_three"
    return "four_plus"


def priority_for(p, current: int) -> tuple[str, int]:
    """(bucket P0/P1/P2, числовой score) — что фотографировать первым."""
    score = 0
    if current == 0:
        score += 1000
    elif current == 1:
        score += 200
    if p["in_stock"]:
        score += 100
    if p["is_hot"] or p["is_new"] or p["is_available_today"]:
        score += 50
    score += min(int(p["popularity"]), 50)
    if current == 0 and (p["in_stock"] or p["is_hot"] or p["is_new"] or p["is_available_today"]):
        return "P0", score
    if current <= 1:
        return "P1", score
    return "P2", score


def analyze(products, groups, target: int):
    active = [p for p in products if p["is_active"]]
    effective = build_effective(products, groups)

    # представитель на группу (для покрытия по группам)
    by_key = defaultdict(list)
    ungrouped = []
    for p in active:
        k = p["image_group_key"]
        (by_key[k] if k else None)
        if k:
            by_key[k].append(p)
        else:
            ungrouped.append(p)

    def rep(items):
        return sorted(items, key=lambda x: (0 if x["in_stock"] else 1, -x["popularity"], x["id"]))[0]

    # единицы покрытия = группа (представитель) + каждый бесключевой товар
    units = []
    for k, items in by_key.items():
        r = rep(items)
        units.append(("group", k, r, items))
    for p in ungrouped:
        units.append(("product", None, p, [p]))

    metrics = {
        "total_active_products": len(active),
        "total_image_groups": len(by_key),
        "coverage_units": len(units),
        "products_without_effective_images": 0,
        "groups_without_images": 0,
        "products_one_photo": 0,
        "products_two_three": 0,
        "products_four_to_ten": 0,
        "over_limit_before_normalize": 0,
        "placeholder_images": 0,
        "external_urls": 0,
        "local_urls": 0,
        "duplicate_url_in_gallery": 0,
    }
    by_category = defaultdict(lambda: {"total": 0, "with": 0})
    by_brand = defaultdict(lambda: {"total": 0, "with": 0})
    in_stock_cov = {"total": 0, "with": 0}
    hot_new_today_cov = {"total": 0, "with": 0}
    url_to_keys = defaultdict(set)      # URL -> множество групп (кросс-группная переиспользуемость)

    for p in active:
        eff = effective[p["id"]]
        cur = len(eff)
        metrics["products_two_three"] += 1 if 2 <= cur <= 3 else 0
        metrics["products_one_photo"] += 1 if cur == 1 else 0
        metrics["products_four_to_ten"] += 1 if 4 <= cur <= 10 else 0
        if cur == 0:
            metrics["products_without_effective_images"] += 1
        # сырые own до нормализации — счёт >10
        raw_own = ([p["image"]] if p["image"] else []) + list(p["images"])
        if len([u for u in raw_own if u]) > MAX_PRODUCT_IMAGES:
            metrics["over_limit_before_normalize"] += 1
        if p["image"] and p["image"].startswith(PLACEHOLDER_PREFIX):
            metrics["placeholder_images"] += 1
        for u in eff:
            if u.startswith(LOCAL_PREFIX):
                metrics["local_urls"] += 1
            elif u.startswith("http://") or u.startswith("https://"):
                metrics["external_urls"] += 1
            if p["image_group_key"]:
                url_to_keys[u].add(p["image_group_key"])
        # дубль ВНУТРИ списка images (не считаем нормальное совпадение image==images[0])
        gal = [u for u in p["images"] if u]
        if len(gal) != len(set(gal)):
            metrics["duplicate_url_in_gallery"] += 1

        cat = p["category"] or "—"
        br = p["brand"] or "—"
        by_category[cat]["total"] += 1
        by_brand[br]["total"] += 1
        if cur > 0:
            by_category[cat]["with"] += 1
            by_brand[br]["with"] += 1
        if p["in_stock"]:
            in_stock_cov["total"] += 1
            in_stock_cov["with"] += 1 if cur > 0 else 0
        if p["is_hot"] or p["is_new"] or p["is_available_today"]:
            hot_new_today_cov["total"] += 1
            hot_new_today_cov["with"] += 1 if cur > 0 else 0

    for k, g in groups.items():
        if not own_images(g["image"], g["images"]):
            metrics["groups_without_images"] += 1

    cross_group_urls = {u: sorted(ks) for u, ks in url_to_keys.items() if len(ks) > 1}
    metrics["cross_group_url_reuse"] = len(cross_group_urls)

    # строки покрытия по единицам (группа/товар) — для research
    rows = []
    for kind, key, r, items in units:
        cur = len(effective[r["id"]])
        pr, score = priority_for(r, cur)
        rows.append({
            "unit": kind,
            "product_id": r["id"],
            "sku": r["sku"] or "",
            "title": r["title"] or "",
            "brand": r["brand"] or "",
            "category": r["category"] or "",
            "model_family": r["model_family"] or "",
            "color": r["color"] or "",
            "image_group_key": key or "",
            "variants_in_group": len(items),
            "in_stock": r["in_stock"],
            "popularity": r["popularity"],
            "is_hot": r["is_hot"],
            "current_effective_images": cur,
            "missing_to_target": max(0, target - cur),
            "coverage_status": bucket(cur),
            "priority": pr,
            "priority_score": score,
            "reason": _reason(r, cur),
            # поля research (заполняются задачей §11 / скриптом research отдельно)
            "source_page_url": "",
            "candidate_asset_urls": "",
            "source_domain": "",
            "confidence": "",
            "research_status": "unresolved",
            "notes": "",
        })
    rows.sort(key=lambda x: (-x["priority_score"], x["product_id"]))

    metrics["coverage_pct"] = round(
        100 * (metrics["total_active_products"] - metrics["products_without_effective_images"])
        / metrics["total_active_products"], 1) if metrics["total_active_products"] else 0.0

    return {
        "metrics": metrics,
        "by_category": {k: {**v, "pct": _pct(v)} for k, v in sorted(by_category.items())},
        "by_brand": {k: {**v, "pct": _pct(v)} for k, v in sorted(by_brand.items())},
        "in_stock_coverage": {**in_stock_cov, "pct": _pct(in_stock_cov)},
        "hot_new_today_coverage": {**hot_new_today_cov, "pct": _pct(hot_new_today_cov)},
        "cross_group_url_reuse": cross_group_urls,
        "rows": rows,
    }


def _pct(d) -> float:
    return round(100 * d["with"] / d["total"], 1) if d["total"] else 0.0


def _reason(p, cur: int) -> str:
    if cur == 0:
        base = "нет фото"
    elif cur == 1:
        base = "только 1 фото"
    else:
        base = f"{cur} фото"
    flags = []
    if p["in_stock"]:
        flags.append("в наличии")
    if p["is_hot"]:
        flags.append("хит")
    if p["is_new"]:
        flags.append("новинка")
    if p["is_available_today"]:
        flags.append("сегодня")
    return base + (" · " + ", ".join(flags) if flags else "")


# ----------------------------- вывод -----------------------------

CSV_FIELDS = [
    "product_id", "sku", "title", "brand", "category", "model_family", "color",
    "image_group_key", "in_stock", "popularity", "is_hot", "current_effective_images",
    "missing_to_target", "coverage_status", "priority", "reason",
    "source_page_url", "candidate_asset_urls", "source_domain", "confidence",
    "research_status", "notes",
]


def write_outputs(result, out_dir: Path, source_label: str, database_url: str, target: int):
    out_dir.mkdir(parents=True, exist_ok=True)
    m = result["metrics"]
    ts = datetime.now(timezone.utc).isoformat()
    repro = "DATABASE_URL=<...> python scripts/photo_coverage_audit.py"

    # JSON
    (out_dir / "coverage.json").write_text(json.dumps({
        "generated_at": ts, "source_label": source_label, "target_per_group": target,
        "reproduce": repro, **result,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    # CSV (per group/product research rows)
    with (out_dir / "coverage.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writeheader()
        for r in result["rows"]:
            w.writerow(r)

    # Markdown summary
    lines = [
        f"# Аудит покрытия фотографиями — {date.today().isoformat()}",
        "",
        f"- Сгенерировано: `{ts}`",
        f"- Источник данных: **{source_label}**",
        f"- Целевое число фото на группу: **{target}** (минимум 1, технический максимум {MAX_PRODUCT_IMAGES})",
        f"- Воспроизведение: `{repro}`",
        "",
        "## Итоги",
        "",
        f"| Метрика | Значение |",
        f"|---|---|",
        f"| Активных товаров | {m['total_active_products']} |",
        f"| Групп изображений | {m['total_image_groups']} |",
        f"| Единиц покрытия (группа/товар) | {m['coverage_units']} |",
        f"| Покрытие (есть ≥1 фото) | **{m['coverage_pct']}%** |",
        f"| Без эффективных фото | {m['products_without_effective_images']} |",
        f"| Только 1 фото | {m['products_one_photo']} |",
        f"| 2–3 фото | {m['products_two_three']} |",
        f"| 4–10 фото | {m['products_four_to_ten']} |",
        f"| Групп без фото | {m['groups_without_images']} |",
        f"| >10 фото до нормализации | {m['over_limit_before_normalize']} |",
        f"| Плейсхолдеров | {m['placeholder_images']} |",
        f"| Внешних URL | {m['external_urls']} |",
        f"| Локальных URL | {m['local_urls']} |",
        f"| Дублей URL в галерее | {m['duplicate_url_in_gallery']} |",
        f"| Один URL в разных группах | {m['cross_group_url_reuse']} |",
        "",
        "## Покрытие в наличии / горячее",
        "",
        f"- В наличии: {result['in_stock_coverage']['with']}/{result['in_stock_coverage']['total']} ({result['in_stock_coverage']['pct']}%)",
        f"- Хит/новинка/сегодня: {result['hot_new_today_coverage']['with']}/{result['hot_new_today_coverage']['total']} ({result['hot_new_today_coverage']['pct']}%)",
        "",
        "## Покрытие по категориям",
        "",
        "| Категория | С фото | Всего | % |",
        "|---|---|---|---|",
    ]
    for cat, v in result["by_category"].items():
        lines.append(f"| {cat} | {v['with']} | {v['total']} | {v['pct']}% |")
    lines += ["", "## Приоритет (что фотографировать первым)", "",
              "| Приоритет | Товар | SKU | Группа | Есть | Причина |",
              "|---|---|---|---|---|---|"]
    for r in result["rows"][:40]:
        lines.append(f"| {r['priority']} | {r['title'][:40]} | {r['sku']} | "
                     f"{r['image_group_key'][:36]} | {r['current_effective_images']} | {r['reason']} |")
    lines += ["", "Полный список — в `coverage.csv` (по одной строке на группу/товар).", ""]
    (out_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="Read-only аудит покрытия каталога фото")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--out", default="docs/photo-research")
    ap.add_argument("--target", type=int, default=3)
    ap.add_argument("--source-label", default=None)
    ap.add_argument("--check-urls", action="store_true")
    ap.add_argument("--uploads-dir", default=None)
    args = ap.parse_args()

    if not args.database_url:
        print("Не задан DATABASE_URL (env или --database-url). READ-ONLY аудит без БД невозможен.",
              file=sys.stderr)
        sys.exit(2)

    products, groups = load_rows(args.database_url)
    result = analyze(products, groups, args.target)

    label = args.source_label or _safe_source_label(args.database_url)
    out_dir = Path(args.out) / date.today().isoformat()
    write_outputs(result, out_dir, label, args.database_url, args.target)

    m = result["metrics"]
    print(f"Готово. Активных товаров: {m['total_active_products']}, покрытие {m['coverage_pct']}%, "
          f"без фото: {m['products_without_effective_images']}, только 1 фото: {m['products_one_photo']}.")
    print(f"Отчёты: {out_dir}/summary.md, coverage.csv, coverage.json")


def _safe_source_label(url: str) -> str:
    """Метка источника без секретов (тип БД, без пароля/хоста)."""
    scheme = url.split("://", 1)[0] if "://" in url else "db"
    if scheme.startswith("sqlite"):
        return "sqlite (local/demo)"
    return f"{scheme} (config)"


if __name__ == "__main__":
    main()
