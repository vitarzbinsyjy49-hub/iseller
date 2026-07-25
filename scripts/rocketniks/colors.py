"""Canonical colour vocabulary (RU↔EN) for Rocketniks matching.

Rocketniks returns colours in Russian (structured ``color.name`` and inside the
product ``name``); our iSeller catalogue uses English. We normalise both sides to
one canonical English token so a colour comparison is language-agnostic.

Direction of error is deliberately safe: an *unknown* colour on either side yields
``None`` (→ the matcher treats colour as "unknown", never as a false match).
Multi-word phrases are matched before single words ("space gray" before "gray",
"ceramic pink" before "pink").
"""
from __future__ import annotations

import re
import unicodedata

# canonical token -> every synonym (RU + EN) that maps to it
_SYNONYMS: dict[str, list[str]] = {
    "black": ["black", "чёрный", "черный", "чёрная", "черная"],
    "white": ["white", "белый", "белая"],
    "silver": ["silver", "серебристый", "серебро", "серебряный"],
    "space black": ["space black", "космический чёрный", "космический черный", "чёрный космос"],
    "space gray": ["space gray", "space grey", "серый космос", "космический серый"],
    "gray": ["gray", "grey", "серый"],
    "graphite": ["graphite", "графит", "графитовый"],
    "gold": ["gold", "золотой", "золото", "золотистый"],
    "rose gold": ["rose gold", "розовое золото"],
    "midnight": ["midnight", "тёмная ночь", "темная ночь", "полуночный", "полночный"],
    "starlight": ["starlight", "сияющая звезда", "сияющая", "звездный свет", "звёздный свет"],
    "sky blue": ["sky blue", "небесно-голубой", "небесно голубой", "голубое небо"],
    "blue": ["blue", "синий", "синие", "голубой", "синие румяна"],
    "green": ["green", "зелёный", "зеленый"],
    "sage": ["sage", "шалфей", "шалфейный"],
    "red": ["red", "красный"],
    "purple": ["purple", "фиолетовый", "фиолетовый туман"],
    "lilac": ["lilac", "сиреневый", "лавандовый"],
    "pink": ["pink", "розовый"],
    "ceramic pink": ["ceramic pink", "керамический розовый"],
    "yellow": ["yellow", "жёлтый", "желтый"],
    "orange": ["orange", "оранжевый"],
    "titanium": ["titanium", "титановый", "титан"],
    "natural titanium": ["natural titanium", "натуральный титан", "природный титан"],
    "blue titanium": ["blue titanium", "синий титан"],
    "white titanium": ["white titanium", "белый титан"],
    "black titanium": ["black titanium", "чёрный титан", "черный титан"],
    "desert titanium": ["desert titanium", "песочный титан"],
    # Dyson beauty finishes (appear in both our EN titles and RU names)
    "apricot": ["apricot", "абрикос", "абрикосовый"],
    "topaz": ["topaz", "топаз", "топазовый"],
    "amber": ["amber", "янтарь", "янтарный"],
    "nickel": ["nickel", "никель", "никелевый"],
    "copper": ["copper", "медь", "медный"],
    "kanzan pink": ["kanzan pink", "kanzan", "канзан"],
    "vinca blue": ["vinca blue", "vinca", "винка"],
    "jasper plum": ["jasper plum", "jasper", "яшма", "сливовый"],
    "prussian blue": ["prussian blue", "берлинская лазурь"],
    "ceramic": ["ceramic", "керамический", "керамика"],
}

# canonical -> canonical (identity) plus synonym -> canonical
_CANON: dict[str, str] = {}
for _canon, _syns in _SYNONYMS.items():
    for _s in _syns:
        _CANON[_s] = _canon

# phrases longest-first so multi-word wins
_PHRASES: list[str] = sorted(_CANON, key=len, reverse=True)

_DASH_RE = re.compile(r"[‐-―−]")
_SPACE_RE = re.compile(r"\s+")
_WORD = "0-9a-zа-яё"

# Cyrillic homoglyphs → Latin lookalikes. Applied ONLY inside a mixed-script token
# (e.g. "Bluе" where the final е is Cyrillic) so genuine Russian words are untouched.
_HOMOGLYPH = str.maketrans({
    "а": "a", "е": "e", "о": "o", "с": "c", "р": "p", "у": "y", "х": "x",
    "к": "k", "м": "m", "т": "t", "н": "h", "в": "b", "і": "i", "ј": "j",
    "ѕ": "s", "ё": "e", "ԁ": "d",
})
_LAT = re.compile(r"[a-z]")
_CYR = re.compile(r"[а-яё]")


def deconfuse(s: str) -> str:
    """Fix mixed-script tokens: a token containing BOTH Latin and Cyrillic letters
    is treated as a Latin word whose lookalike Cyrillic chars are transliterated."""
    out = []
    for tok in s.split(" "):
        if _LAT.search(tok) and _CYR.search(tok):
            tok = tok.translate(_HOMOGLYPH)
        out.append(tok)
    return " ".join(out)


def _norm(s) -> str:
    if s is None:
        return ""
    s = unicodedata.normalize("NFC", str(s)).lower()
    s = _DASH_RE.sub("-", s)
    s = _SPACE_RE.sub(" ", s).strip()
    return deconfuse(s)


def canon_color(value) -> str | None:
    """Exact structured colour field ('белый', 'Sky Blue') → canonical token."""
    v = _norm(value)
    if not v:
        return None
    return _CANON.get(v)


def find_colors(text) -> set[str]:
    """All canonical colours mentioned as whole phrases inside free text.

    Longest phrases win and consume their span, so "space gray" is not also
    counted as bare "gray"."""
    t = _norm(text)
    if not t:
        return set()
    out: set[str] = set()
    for phrase in _PHRASES:                       # longest-first
        pat = rf"(?<![{_WORD}]){re.escape(phrase)}(?![{_WORD}])"
        if re.search(pat, t):
            out.add(_CANON[phrase])
            t = re.sub(pat, " ", t)               # consume so sub-words don't re-match
    return out


def primary_color(*sources) -> set[str]:
    """Union of canonical colours from any of the given sources (structured field
    value or free text). Empty set = colour unknown."""
    out: set[str] = set()
    for s in sources:
        c = canon_color(s)
        if c:
            out.add(c)
        out |= find_colors(s)
    return out
