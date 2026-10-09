"""Строки прайса поставщика -> (ключ, цена). Чистые функции: ни базы, ни сети.

Ключ — то, что НЕ меняется, когда поставщик правит цену: по нему наша карточка
каждый день находит «свою» строку. Три вида, от надёжного к хрупкому:

- ``ip:<SKU>``  — iPhone, разобранный services/bsa_parser (модель, память, цвет,
  регион, SIM, ASIS). Тот же SKU, что у карточек, заведённых import_bsa;
- ``art:<артикул>`` — артикул Apple в строке (MDVH4, Z1L8000Q6);
- ``txt:<текст>`` — нормализованная строка без цены: регион флагами -> коды,
  без эмодзи, пунктуации и регистра.

Хрупкость txt-ключа (поставщик поправил слово) закрывает поиск по сходству в
services/price_sync, а не этот модуль.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

_PRICE_RE = re.compile(r"(?<![\w.])(\d{1,3}(?:[.\s ]\d{3})+|\d{4,7})(?![\w])")
_ART_RE = re.compile(r"(?<![A-Z0-9])(M[A-Z0-9]{3}\d|Z1[A-Z0-9]{7})(?![A-Z0-9])")
_FLAG_RE = re.compile(r"[\U0001F1E6-\U0001F1FF]{2}")
MIN_PRICE = 1000


@dataclass(frozen=True)
class SourceLine:
    key: str
    price: int
    line: str


def flags_to_codes(text: str) -> str:
    def code(m: re.Match) -> str:
        return " " + "".join(chr(ord(ch) - 0x1F1E6 + ord("A")) for ch in m.group(0)) + " "
    return _FLAG_RE.sub(code, text)


def _price_match(line: str) -> re.Match | None:
    """Последнее число-цена (≥ MIN_PRICE, и не год 2020–2030 перед скобкой/словом)."""
    found = None
    for m in _PRICE_RE.finditer(line):
        value = int(re.sub(r"[.\s ]", "", m.group(1)))
        if value < MIN_PRICE or (2020 <= value <= 2030 and "." not in m.group(1)
                                 and m.end() < len(line.rstrip(" *🔥")) and line[m.end():].strip()[:1] not in ("", "*")):
            continue
        found = m
    return found


def line_price(line: str) -> int | None:
    """Последнее число-цена в строке («-133.000», «— 41 500», «73500»)."""
    m = _price_match(line.replace("..", "."))
    return int(re.sub(r"[.\s ]", "", m.group(1))) if m else None


def text_key(line: str) -> str:
    """Строка без цены, эмодзи и знаков: «🇭🇰 HS08 Amber Silk — 40.000» -> «hk hs08 amber silk».
    Убирается ТОЛЬКО цена: год модели («2026») остаётся частью ключа."""
    s = line.replace("..", ".")
    m = _price_match(s)
    if m:
        s = s[:m.start()] + " " + s[m.end():]
    s = flags_to_codes(s)
    s = "".join(ch if (ch.isalnum() or ch in "/+") else " " for ch in unicodedata.normalize("NFKC", s))
    return " ".join(s.lower().split())


def article(line: str) -> str | None:
    found = _ART_RE.findall(line)
    return found[0] if len(set(found)) == 1 else None


def parse_text(text: str) -> list[SourceLine]:
    """Все строки с ценой из текста поста. Активированные iPhone пропускаются."""
    from app.services.bsa_parser import parse
    out: list[SourceLine] = []
    for raw in text.splitlines():
        line = raw.strip().strip("️‍ ")
        price = line_price(line)
        if not line or price is None:
            continue
        items, _failed = parse(line)
        if items:
            item = items[0]
            if item.activated:
                continue
            out.append(SourceLine(f"ip:{item.sku}", int(item.price), line))
            continue
        art = article(line)
        if art:
            out.append(SourceLine(f"art:{art}", price, line))
            continue
        key = text_key(line)
        if len(key) >= 6:
            out.append(SourceLine(f"txt:{key}", price, line))
    return out
