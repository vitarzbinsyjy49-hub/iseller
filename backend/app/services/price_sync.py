"""Ежедневная сверка цен с поставщиком (BSA): строки -> справочные цены -> расхождения.

Цепочка (docs/superpowers/specs/2026-10-07-price-admin-design.md, этап 2):
1. ingest — строки прайса (source_lines.SourceLine) пишутся в price_refs;
2. каждая наша карточка привязана к ключу строки (price_links, один раз);
3. reference_for — для карточки берётся её строка; если с ключом их несколько,
   выбирается самая похожая на текст привязки; если ключ пропал (поставщик
   поправил слово), строка ищется по сходству текста и привязка «лечится»;
4. discrepancies — где наша цена ≠ цена поставщика − NAKIDKA.

Наши цены здесь НЕ меняются: решение за администратором (экран «Цены»).
"""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.price_ref import PriceLink, PriceRef
from app.models.product import Product
from app.services.source_lines import SourceLine, parse_text, text_key

SOURCE = "bsa"
NAKIDKA = 500                     # то же правило, что в scripts/import_bsa.py
FRESH = timedelta(hours=36)       # «видели сегодня» с запасом на поздний прогон
HEAL_SIMILARITY = 0.9


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(v: datetime | None) -> datetime | None:
    return v.replace(tzinfo=timezone.utc) if v is not None and v.tzinfo is None else v


def suggested(ref_price: int) -> int:
    return max(int(ref_price) - NAKIDKA, 0)


# ------------------------------------------------------------------ ingest ----
def ingest(db: Session, lines: list[SourceLine], *, post_id: int | None = None,
           source: str = SOURCE, now: datetime | None = None) -> int:
    """Записать увиденные строки. Возвращает число строк."""
    now = now or _now()
    existing = {(r.key, r.line_key): r for r in db.execute(
        select(PriceRef).where(PriceRef.source == source)).scalars()}
    seen: set[tuple[str, str]] = set()
    for sl in lines:
        lk = text_key(sl.line)[:300]
        k = (sl.key[:160], lk)
        if k in seen:
            continue
        seen.add(k)
        row = existing.get(k)
        if row is None:
            db.add(PriceRef(source=source, key=k[0], line_key=lk, price=sl.price, line=sl.line,
                            post_id=post_id, seen_at=now))
        else:
            row.price, row.line, row.seen_at = sl.price, sl.line, now
            if post_id is not None:
                row.post_id = post_id
    db.flush()
    return len(seen)


def ingest_text(db: Session, text: str, *, post_id: int | None = None, now: datetime | None = None) -> int:
    return ingest(db, parse_text(text), post_id=post_id, now=now)


# ----------------------------------------------------------------- linking ----
_BARE_ART = re.compile(r"^(M[A-Z0-9]{3}\d|Z1[A-Z0-9]{7})$")


def link(db: Session, product_id: int, key: str, line: str | None, origin: str,
         source: str = SOURCE) -> PriceLink:
    row = db.execute(select(PriceLink).where(PriceLink.product_id == product_id,
                                             PriceLink.source == source)).scalar_one_or_none()
    if row is None:
        row = PriceLink(product_id=product_id, source=source, key=key, line=line, origin=origin)
        db.add(row)
    else:
        row.key, row.line, row.origin = key, line, origin
    return row


def seed_links(db: Session, links_tsv: Path | None = None) -> dict:
    """Привязать всё, что можно, автоматически. Существующие привязки не трогает."""
    linked = {pid for (pid,) in db.execute(select(PriceLink.product_id).where(PriceLink.source == SOURCE))}
    stats = {"iphone": 0, "article": 0, "tsv": 0}
    by_sku = {p.sku: p for p in db.execute(select(Product).where(Product.sku.is_not(None))).scalars()}

    if links_tsv and links_tsv.exists():
        for raw in links_tsv.read_text(encoding="utf-8").splitlines():
            if not raw.strip() or raw.startswith("#"):
                continue
            sku, _price, src_line = raw.split("\t", 2)
            p = by_sku.get(sku)
            parsed = parse_text(src_line)
            if p is None or p.id in linked or not parsed:
                continue
            link(db, p.id, parsed[0].key, src_line, "seed")
            linked.add(p.id)
            stats["tsv"] += 1

    for sku, p in by_sku.items():
        if p.id in linked:
            continue
        if p.source == "bsa" and sku.startswith("IP-"):
            link(db, p.id, f"ip:{sku}", None, "auto")
        else:
            base = sku.split("-")[0]
            if "RS/A" in sku or not _BARE_ART.match(base):
                continue
            # MU9E3-US (карточка BSA) или MDVH4 (импорт) — артикул Apple.
            link(db, p.id, f"art:{base}", None, "auto")
            stats["article"] += 1
            linked.add(p.id)
            continue
        stats["iphone"] += 1
        linked.add(p.id)
    db.flush()
    return stats


# --------------------------------------------------------------- reference ----
@dataclass
class Reference:
    price: int
    suggested: int
    line: str
    seen_at: datetime
    fresh: bool
    healed: bool = False


def _similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def _pick(refs: list[PriceRef], link_line: str | None) -> PriceRef | None:
    if not refs:
        return None
    if len(refs) == 1 or not link_line:
        return max(refs, key=lambda r: _aware(r.seen_at))
    target = text_key(link_line)
    return max(refs, key=lambda r: (_similar(r.line_key, target), _aware(r.seen_at)))


def reference_for(db: Session, product_ids: list[int], *, heal: bool = False,
                  now: datetime | None = None) -> dict[int, Reference]:
    now = now or _now()
    if not product_ids:
        return {}
    links = db.execute(select(PriceLink).where(PriceLink.source == SOURCE,
                                               PriceLink.product_id.in_(product_ids))).scalars().all()
    keys = {l.key for l in links}
    refs_by_key: dict[str, list[PriceRef]] = {}
    for r in db.execute(select(PriceRef).where(PriceRef.source == SOURCE, PriceRef.key.in_(keys))).scalars():
        refs_by_key.setdefault(r.key, []).append(r)
    fresh_txt: list[PriceRef] | None = None
    out: dict[int, Reference] = {}
    for l in links:
        ref = _pick(refs_by_key.get(l.key, []), l.line)
        healed = False
        is_fresh = ref is not None and now - _aware(ref.seen_at) <= FRESH
        if heal and not is_fresh and l.key.startswith("txt:") and l.line:
            if fresh_txt is None:
                since = now - FRESH
                fresh_txt = list(db.execute(select(PriceRef).where(
                    PriceRef.source == SOURCE, PriceRef.key.like("txt:%"), PriceRef.seen_at >= since)).scalars())
            target = text_key(l.line)
            best = max(fresh_txt, key=lambda r: _similar(r.line_key, target), default=None)
            if best is not None and _similar(best.line_key, target) >= HEAL_SIMILARITY:
                l.key, l.line, l.origin = best.key, best.line, "healed"
                ref, healed, is_fresh = best, True, True
        if ref is None:
            continue
        out[l.product_id] = Reference(ref.price, suggested(ref.price), ref.line, _aware(ref.seen_at),
                                      is_fresh, healed)
    return out


# ----------------------------------------------------------- discrepancies ----
@dataclass
class Discrepancy:
    product_id: int
    sku: str | None
    title: str
    our_price: int
    ref: Reference

    @property
    def delta(self) -> int:
        return self.ref.suggested - self.our_price


def discrepancies(db: Session, *, now: datetime | None = None, heal: bool = True) -> tuple[list[Discrepancy], dict]:
    """Расхождения по карточкам в продаже + статистика сверки."""
    products = db.execute(select(Product).where(Product.is_active.is_(True), Product.in_stock.is_(True))).scalars().all()
    refs = reference_for(db, [p.id for p in products], heal=heal, now=now)
    linked = {pid for (pid,) in db.execute(select(PriceLink.product_id).where(PriceLink.source == SOURCE))}
    stats = {"in_stock": len(products), "linked": sum(1 for p in products if p.id in linked),
             "checked": sum(1 for r in refs.values() if r.fresh),
             "missing_today": sum(1 for p in products if p.id in linked and not (refs.get(p.id) and refs[p.id].fresh)),
             "healed": sum(1 for r in refs.values() if r.healed)}
    diffs = [Discrepancy(p.id, p.sku, p.title, int(round(float(p.price or 0))), refs[p.id])
             for p in products if p.id in refs and refs[p.id].fresh
             and int(round(float(p.price or 0))) != refs[p.id].suggested]
    diffs.sort(key=lambda d: -abs(d.delta))
    stats["diff"] = len(diffs)
    return diffs, stats


def summary_text(stats: dict, diffs: list[Discrepancy], posts_ok: int, posts_failed: list[int]) -> str:
    lines = ["🔎 <b>Сверка цен с BSA</b>",
             f"Прочитано постов: {posts_ok}" + (f", не прочитаны: {', '.join(map(str, posts_failed))}" if posts_failed else ""),
             f"В продаже: {stats['in_stock']}, привязано к BSA: {stats['linked']}, сверено сегодня: {stats['checked']}.",
             f"<b>Расходится с BSA − {NAKIDKA}: {stats['diff']}</b>"]
    for d in diffs[:8]:
        lines.append(f"• {d.title[:48]}: у нас {d.our_price:,} → {d.ref.suggested:,}".replace(",", " "))
    if len(diffs) > 8:
        lines.append(f"… и ещё {len(diffs) - 8}")
    if stats["missing_today"]:
        lines.append(f"Нет у BSA сегодня (или пост не прочитан): {stats['missing_today']}")
    lines.append("Открыть: кнопка меню «⚙️ Админка» → фильтр «Расходится с BSA».")
    return "\n".join(lines)


def auto_apply(db: Session, diffs: list[Discrepancy], max_change: float) -> tuple[list[Discrepancy], list[Discrepancy]]:
    """Поставить BSA − NAKIDKA там, где изменение в пределах max_change.
    Возвращает (применённые, отложенные на подтверждение). Пишет историю цен
    с source=bsa — откат одной кнопкой в «Ценах»."""
    from app.services.price_history import attribute
    applied, held = [], []
    products = {p.id: p for p in db.execute(select(Product).where(
        Product.id.in_([d.product_id for d in diffs]))).scalars()}
    for d in diffs:
        p = products.get(d.product_id)
        if p is None:
            continue
        if d.our_price and abs(d.delta) / d.our_price > max_change:
            held.append(d)
            continue
        attribute(db, actor="system", source="bsa", note=f"BSA: {d.ref.line[:200]}")
        p.price = d.ref.suggested
        db.flush()                      # история пишется на flush — с этой подписью
        applied.append(d)
    return applied, held


def _fmt(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def report_text(stats: dict, applied: list[Discrepancy], held: list[Discrepancy],
                posts_ok: int, posts_failed: list[int]) -> str:
    lines = ["📊 <b>Цены сверены с BSA</b>",
             f"Прочитано постов BSA: {posts_ok}" + (f" (не прочитаны: {', '.join(map(str, posts_failed))})" if posts_failed else ""),
             f"В продаже {stats['in_stock']} · привязано к BSA {stats['linked']} · сверено сегодня {stats['checked']}"]
    up = [d for d in applied if d.delta > 0]
    down = [d for d in applied if d.delta < 0]
    lines.append(f"\n<b>Изменено цен: {len(applied)}</b> (выросло {len(up)}, снизилось {len(down)})")
    for d in sorted(applied, key=lambda d: -abs(d.delta))[:15]:
        sign = "▲" if d.delta > 0 else "▼"
        lines.append(f"{sign} {d.title[:46]}: {_fmt(d.our_price)} → {_fmt(d.ref.suggested)}")
    if len(applied) > 15:
        lines.append(f"… и ещё {len(applied) - 15}")
    if held:
        lines.append(f"\n⚠️ <b>Ждут подтверждения: {len(held)}</b> (изменение больше 25% — проверьте, не опечатка ли у BSA)")
        for d in held[:8]:
            lines.append(f"• {d.title[:46]}: {_fmt(d.our_price)} → {_fmt(d.ref.suggested)}")
    if stats.get("missing_today"):
        lines.append(f"\nНет в прайсе BSA сегодня: {stats['missing_today']} (цены не трогали)")
    lines.append("\nПрайс в группе обновится в 10:30. Подробно и откат — «⚙️ Админка».")
    return "\n".join(lines)
