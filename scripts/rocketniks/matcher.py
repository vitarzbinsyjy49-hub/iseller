"""Deterministic iSeller ↔ Rocketniks product matcher (read-only, no network).

Given one iSeller product ({sku, title}) and a list of Rocketniks candidates
({name, vendorCode, url, color?}), produce a scored, explained match with a status.

Scoring (max 100):
    exact article (vendorCode≈SKU)   50
    model / generation               25
    colour                           15
    physical size                     5
    significant configuration         5

Any *hard* conflict (colour, case size, screen size, device/model code, family,
design generation) forbids an auto (exact/likely) match — the exact variant is not
present, so we must not apply a wrong-variant gallery. *Soft* conflicts (year/chip
of an otherwise identical body, ANC/non-ANC) cap the result at ``review`` for a human.

Everything here is pure and unit-testable; the network client lives in client.py.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .colors import canon_color, deconfuse, primary_color

# ---- tokenisation & noise stripping ----
_REGION_RE = re.compile(r"\((?:us|in|gb|hk|kr|eu|jp|cn|us-in|ru|world|global)[^)]*\)", re.I)
_SIM_RE = re.compile(r"\b(sim\s*\+\s*esim|nano-?sim\s*\+\s*esim|nano-?sim|e-?sim|dual\s*sim|sim)\b", re.I)
_MEM_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:gb|гб|tb|тб|mb|мб)\b", re.I)
_RAM_RE = re.compile(r"\b\d{1,3}\s*/\s*\d{1,4}\b")          # 16/256, 18/32
_BAND_RE = re.compile(r"\b([sml])\s*/\s*([sml])\b", re.I)   # S/M, M/L
_WS = re.compile(r"\s+")

# Dyson model code: 2 letters + digits (+opt letter), e.g. HD16, HS08, SV46, WR03, SP01
_DYSON_CODE_RE = re.compile(r"\b([a-z]{2}\d{1,3}[a-z]?)\b", re.I)
_MM_RE = re.compile(r"\b(\d{2})\s*(?:mm|мм)\b", re.I)
_INCH_RE = re.compile(r"\b(1[0-9])(?:[.,]\d)?\s*(?:\"|inch|дюйм)?\b")  # rough; refined by family


def _norm(s: str) -> str:
    return deconfuse(_WS.sub(" ", (s or "").lower().replace("”", '"').replace("''", '"')).strip())


def tokens(s: str) -> set[str]:
    return set(re.findall(r"[a-zа-яё0-9]+", _norm(s)))


def normalize_query(title: str) -> str:
    """Clean an iSeller title into a Rocketniks search query (model + colour)."""
    t = _REGION_RE.sub(" ", title or "")
    t = _SIM_RE.sub(" ", t)
    t = _MEM_RE.sub(" ", t)
    t = _RAM_RE.sub(" ", t)
    t = _BAND_RE.sub(" ", t)
    t = re.sub(r"\b(m[45])\b", "", t, flags=re.I)     # chip: not needed for recall
    return _WS.sub(" ", t).strip(" -/·,()").strip()


FAMILIES = [
    ("airpods max", ["airpods max"]),
    ("airpods pro", ["airpods pro"]),
    ("airpods", ["airpods"]),
    ("watch", ["watch"]),
    ("ipad", ["ipad"]),
    ("iphone", ["iphone"]),
    ("macbook air", ["macbook air"]),
    ("macbook pro", ["macbook pro"]),
    ("imac", ["imac"]),
    ("dyson", ["dyson"]),
]


def family(title: str) -> str:
    t = _norm(title)
    for name, needles in FAMILIES:
        if any(n in t for n in needles):
            return name
    toks = tokens(t)
    return next(iter(sorted(toks)), "?") if toks else "?"


def _iphone_gen(t: str) -> set[str]:
    return set(re.findall(r"iphone\s*(?:air\s*)?(\d{1,2})e?\b", t))


def _watch_series(t: str) -> set[str]:
    return set(re.findall(r"series\s*(\d{1,2})", t))


def _airpods_gen(t: str) -> set[str]:
    return set(re.findall(r"airpods\s*(\d)\b", t))


def _years(t: str) -> set[str]:
    return set(re.findall(r"\b(20\d{2})\b", t))


def _macbook_screen(t: str) -> set[str]:
    # "MacBook Air 13/15", "Pro 14/16" — the standalone size right after air/pro
    return set(re.findall(r"(?:air|pro)\s*(1[0-9])\b", t))


def _dyson_codes(t: str) -> set[str]:
    return {m.lower() for m in _DYSON_CODE_RE.findall(t)}


@dataclass
class Signature:
    family: str
    colors: set[str] = field(default_factory=set)
    iphone_gen: set[str] = field(default_factory=set)
    watch_series: set[str] = field(default_factory=set)
    airpods_gen: set[str] = field(default_factory=set)
    years: set[str] = field(default_factory=set)
    mm: set[str] = field(default_factory=set)
    screen: set[str] = field(default_factory=set)
    dyson: set[str] = field(default_factory=set)
    anc: bool | None = None
    model_tokens: set[str] = field(default_factory=set)


_STOP = {
    "apple", "с", "разъёмом", "разъемом", "type-c", "usb", "type",
    "русская", "раскладка", "полуночный", "gb", "tb", "case", "кейс",
}


def signature(title: str, *, color_field: str | None = None) -> Signature:
    t = _norm(title)
    cols = primary_color(title, color_field)
    anc = None
    if "airpods" in t:
        if re.search(r"non[- ]?anc|без\s*anc|no anc", t):
            anc = False
        elif "anc" in t or "pro" in t or "max" in t:
            anc = True
    # model tokens: strip colours, memory, region, sim, generic stopwords
    base = _REGION_RE.sub(" ", t)
    base = _SIM_RE.sub(" ", base)
    base = _MEM_RE.sub(" ", base)
    base = _RAM_RE.sub(" ", base)
    for c in cols:
        base = base.replace(c, " ")
    # drop any residual colour-synonym token (RU words like "синий", "полуночный")
    mt = {tok for tok in tokens(base)
          if tok not in _STOP and len(tok) > 1 and canon_color(tok) is None}
    return Signature(
        family=family(title), colors=cols,
        iphone_gen=_iphone_gen(t), watch_series=_watch_series(t),
        airpods_gen=_airpods_gen(t), years=_years(t) if "airpods max" in t else set(),
        mm=set(_MM_RE.findall(t)),
        screen=_macbook_screen(t) if "macbook" in t else set(),
        dyson=_dyson_codes(t) if "dyson" in t else set(),
        anc=anc, model_tokens=mt,
    )


def _norm_code(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


@dataclass
class MatchResult:
    score: int
    status: str                     # exact | likely | review | rejected | not_found
    matched: list[str]
    missing: list[str]
    conflicts: list[str]            # hard conflicts (block auto)
    soft_conflicts: list[str]       # soft (cap at review)
    candidate: dict | None = None
    model_overlap: float = 0.0      # fraction of our model tokens seen in candidate


HARD = "hard"
SOFT = "soft"


def score_candidate(sku: str, title: str, cand: dict) -> MatchResult:
    """Score one Rocketniks candidate against one iSeller product."""
    cname = cand.get("name", "")
    vendor = cand.get("vendorCode", "")
    ps = signature(title)
    cs = signature(cname, color_field=cand.get("color"))

    matched: list[str] = []
    missing: list[str] = []
    conflicts: list[str] = []
    soft: list[str] = []
    score = 0
    has_article = False

    # --- article (50) ---
    a, b = _norm_code(sku), _norm_code(vendor)
    if a and b and (a == b or (len(b) >= 4 and a.startswith(b)) or (len(a) >= 4 and b.startswith(a))):
        score += 50
        has_article = True
        matched.append(f"article {sku}≈{vendor}")
    else:
        missing.append(f"article {sku}≠{vendor or '—'}")

    # --- family gate ---
    if ps.family != cs.family and not (ps.family in cs.family or cs.family in ps.family):
        conflicts.append(f"family {ps.family}≠{cs.family}")

    family_ok = ps.family == cs.family or ps.family in cs.family or cs.family in ps.family

    # --- model / generation (25) ---
    inter = ps.model_tokens & cs.model_tokens
    frac = len(inter) / max(1, len(ps.model_tokens))
    score += int(25 * frac)
    matched.append(f"model {sorted(inter)} ({frac:.0%})")

    def gen_conflict(pg: set[str], cg: set[str], label: str, severity: str):
        if pg and cg and not (pg & cg):
            (conflicts if severity == HARD else soft).append(f"{label} {sorted(pg)}≠{sorted(cg)}")
        elif pg and (pg & cg):
            matched.append(f"{label} {sorted(pg & cg)}")

    gen_conflict(ps.iphone_gen, cs.iphone_gen, "iphone-gen", HARD)
    gen_conflict(ps.watch_series, cs.watch_series, "watch-series", HARD)
    gen_conflict(ps.airpods_gen, cs.airpods_gen, "airpods-gen", HARD)
    gen_conflict(ps.screen, cs.screen, "macbook-screen", HARD)
    gen_conflict(ps.years, cs.years, "airpods-year", SOFT)   # same USB-C body, new year
    # Dyson model code: different code = different device
    dyson_match = False
    if ps.dyson and cs.dyson:
        if ps.dyson & cs.dyson:
            score += 8
            dyson_match = True
            matched.append(f"dyson-code {sorted(ps.dyson & cs.dyson)}")
        else:
            conflicts.append(f"dyson-code {sorted(ps.dyson)}≠{sorted(cs.dyson)}")

    # --- colour (15) ---
    # color_ok: product colourless, OR colours intersect. color_unknown: product has a
    # colour but the candidate exposes none (→ needs the detail call / human review).
    color_ok = True
    color_unknown = False
    if ps.colors and cs.colors:
        shared = ps.colors & cs.colors
        if shared:
            score += 15
            matched.append(f"color {sorted(shared)}")
            # each side also carries a colour the other lacks → different colourway
            # (e.g. "apricot/topaz" vs "blue-blush/topaz"): shared finish, wrong primary
            if (ps.colors - cs.colors) and (cs.colors - ps.colors):
                color_unknown = True
                missing.append(f"color ± {sorted(ps.colors)} vs {sorted(cs.colors)}")
        else:
            color_ok = False
            conflicts.append(f"color {sorted(ps.colors)}≠{sorted(cs.colors)}")
    elif ps.colors:
        color_unknown = True
        missing.append(f"color {sorted(ps.colors)} vs ?")
    elif cs.colors:
        # candidate is colour-specific but we couldn't read ours → can't confirm the
        # variant; never auto-apply a possibly-wrong colour.
        color_unknown = True
        missing.append(f"color ? vs {sorted(cs.colors)}")

    # --- size (5): watch mm ---
    if ps.mm and cs.mm:
        if ps.mm & cs.mm:
            score += 5
            matched.append(f"size {sorted(ps.mm & cs.mm)}mm")
        else:
            conflicts.append(f"size {sorted(ps.mm)}≠{sorted(cs.mm)}mm")

    # --- config (5): ANC ---
    if ps.anc is not None and cs.anc is not None:
        if ps.anc == cs.anc:
            score += 5
        else:
            soft.append(f"anc {ps.anc}≠{cs.anc}")

    score = min(score, 100)
    if conflicts:
        score = min(score, 50)
    elif soft:
        score = min(score, 74)

    # Status is driven by COMPLETENESS + conflicts, not a raw threshold: a full
    # model+colour(+size) match with no conflict is applicable even when the
    # vendorCode (article) doesn't match ours (true for Dyson / synthetic SKUs).
    strong_model = has_article or dyson_match or frac >= 0.6
    weak_model = not family_ok or (not has_article and not dyson_match and frac < 0.34)

    if conflicts or weak_model:
        status = "rejected"
    elif soft or color_unknown:
        status = "review"                       # human verifies year/ANC or the colour
    elif has_article and color_ok and strong_model:
        status = "exact"
    elif strong_model and color_ok:
        status = "likely"
    else:
        status = "review"

    return MatchResult(score, status, matched, missing, conflicts, soft,
                       candidate=cand, model_overlap=frac)


def match_product(sku: str, title: str, candidates: list[dict]) -> MatchResult:
    """Pick the best-explained match for one product across all candidates.

    Prefers a conflict-free candidate; only if none exists does it surface the
    best conflicting one (for a human), never as exact/likely. If even the best
    candidate shares no model tokens with us (pure search noise, e.g. Sony
    accessories the source doesn't carry), report not_found rather than rejected.
    """
    if not candidates:
        return MatchResult(0, "not_found", [], ["no candidates"], [], [])
    scored = [score_candidate(sku, title, c) for c in candidates]
    clean = [m for m in scored if not m.conflicts]
    if clean:
        return max(clean, key=lambda m: m.score)
    best = max(scored, key=lambda m: m.score)
    if best.model_overlap <= 0.0 and "article" not in " ".join(best.matched):
        # no real overlap with any candidate → the source doesn't carry this product
        return MatchResult(best.score, "not_found", best.matched, best.missing,
                           best.conflicts, best.soft_conflicts, candidate=None)
    return best
