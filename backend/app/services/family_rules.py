"""Правила склейки вариантов по линейкам: товар -> модель + оси варианта.

Каждая линейка пишет название по-своему, и одно общее правило либо не склеит
ничего, либо склеит разные товары. Поэтому здесь по правилу на линейку, и
каждое намеренно консервативно: не разобрал уверенно — вернул None, товар
остаётся отдельной карточкой. Слить два разных товара в одну карточку хуже,
чем не слить два одинаковых.

Результат правил сохраняется в товар (`family_key`, `variant` —
scripts/backfill_families.py, import_bsa), и уже сохранённое главнее правил:
ручная правка в админке не перетирается следующим прогоном.

Не склеиваются сейчас: Apple Watch (размер, корпус и ремешок в одной строке
без разделителей), пылесосы Dyson (у каждой модели своя комплектация), всё
уценённое или с ремонтом — это отдельное предложение, а не вариант.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.services.price_posts import split_region_codes

#: Порядок осей на экране и их «вес» при вынужденном компромиссе
#: (frontend/lib/variants.ts держит те же веса): цвет видно сразу, и его
#: подмена — самый заметный сюрприз.
AXIS_ORDER = ("Цвет", "Память", "Конфигурация", "Связь", "SIM", "Комплектация")

#: Пометки, с которыми товар — не вариант модели, а отдельное предложение.
_ONE_OFF = re.compile(r"замен|ремонт|восстановл|\bRFB\b|\bASIS\b|\[|витрин|б/у", re.I)


@dataclass
class Resolved:
    family: str
    variant: dict[str, str]
    regions: list[str] = field(default_factory=list)


def _gb(number: str) -> str:
    """«1» + TB -> «1 ТБ», «512» -> «512 ГБ»."""
    return f"{number} ГБ"


def _storage(raw: str) -> str:
    raw = raw.strip().upper().replace(" ", "")
    m = re.match(r"^(\d+)(TB|ТБ|GB|ГБ|G)?$", raw)
    if not m:
        return raw
    number, unit = m.groups()
    if unit in ("TB", "ТБ") or (unit is None and number in ("1", "2", "4", "8", "16")):
        return f"{number} ТБ"
    return _gb(number)


#: Числа, похожие на объём оперативной памяти Mac.
_RAM = {"8", "16", "18", "24", "32", "36", "48", "64", "96", "128", "256", "512"}


def mac_config(text: str) -> str | None:
    """«15/16 24GB 1TB», «(16/1Tb)», «18C/20C/48Gb/1Tb», «28 60 96GB 1TB»
    -> «15/16 · 24 ГБ · 1 ТБ». None, если накопитель не нашёлся.

    Логика: последний объём — накопитель; число перед ним — оперативная
    память; два числа ещё раньше — ядра CPU/GPU. Этого хватает на все формы,
    которые встречаются в прайсе, а чего не хватает — возвращает None."""
    tokens = re.findall(r"(\d+)\s*(TB|Tb|tb|GB|Gb|gb|G|C|c)?", text)
    if not tokens:
        return None
    ssd_i = None
    for i in range(len(tokens) - 1, -1, -1):
        number, unit = tokens[i]
        if (unit or "").upper() == "TB" or (unit.upper() in ("GB", "G", "") and number in ("256", "512")
                                             and i == len(tokens) - 1):
            ssd_i = i
            break
    if ssd_i is None:
        return None
    ssd = _storage(tokens[ssd_i][0] + (tokens[ssd_i][1] or ""))
    rest = [t for t in tokens[:ssd_i] if (t[1] or "").upper() != "TB"]
    ram = None
    if rest and rest[-1][0] in _RAM:
        ram = rest.pop()[0]
    elif len(rest) == 3 and rest[0][0] in _RAM:
        # «16/10/10/512GB»: память стоит первой, ядра — за ней.
        ram = rest.pop(0)[0]
    cores = [n for n, u in rest if n not in ("5", "4", "3", "2", "1")][-2:]
    parts = []
    if len(cores) == 2:
        parts.append(f"{cores[0]}/{cores[1]}")
    if ram:
        parts.append(_gb(ram))
    parts.append(ssd)
    return " · ".join(parts)


def _color_from(product, text: str) -> str | None:
    color = (getattr(product, "color", None) or "").strip()
    if color:
        return color
    text = text.strip(" -")
    return text or None


# ---------------------------------------------------------------- линейки

_IPHONE = re.compile(
    r"^(?P<model>.+?)\s+(?P<storage>\d+\s?(?:ГБ|ТБ))\s+(?P<color>[^\[\]()]+?)"
    r"(?:\s+\((?P<sim>[^)]*)\))?\s*$", re.I)


def _iphone(product, clean: str):
    m = _IPHONE.match(clean)
    if not m or "iphone" not in m["model"].lower():
        return None
    variant = {"Цвет": m["color"].strip(), "Память": re.sub(r"\s+", " ", m["storage"]).upper()}
    if m["sim"]:
        variant["SIM"] = m["sim"].strip()
    return m["model"].strip(), variant


_IPAD = re.compile(
    r'^(?P<model>Apple iPad (?:Pro|Air)(?: \d+)?(?: \d+"?)? M\d+)\s+(?P<storage>\d+\s?(?:GB|TB|ГБ|ТБ)?)\b(?P<rest>.*)$',
    re.I)


def _ipad(product, clean: str):
    m = _IPAD.match(clean)
    if not m:
        return None
    rest = m["rest"]
    link = "LTE" if re.search(r"\bLTE\b|Cellular", rest, re.I) else "Wi-Fi" if "wi-fi" in rest.lower() else None
    color_text = re.sub(r"\bLTE\b|\bWi-?Fi\b|Cellular", " ", rest, flags=re.I)
    color = _color_from(product, re.sub(r"\s+", " ", color_text))
    if not (link and color):
        return None
    return m["model"].strip(), {"Цвет": color, "Память": _storage(m["storage"]), "Связь": link}


_MACBOOK = re.compile(r"^Apple MacBook (?P<line>Air|Pro) (?P<size>1[3-6])\b(?P<rest>.*)$", re.I)
_CHIP = re.compile(r"\b(M\d)(?:\s*,)?(?:\s+(Pro|Max|Ultra))?\b")


def _macbook(product, clean: str):
    m = _MACBOOK.match(clean)
    if not m:
        return None
    rest = m["rest"]
    chip = _CHIP.search(rest)
    color = getattr(product, "color", None)
    if not chip or not color:
        return None
    chip_name = chip.group(1) + (f" {chip.group(2)}" if chip.group(2) else "")
    after = rest[chip.end():]
    after = re.sub(r"\(20\d\d\)", " ", after)                     # «(2025)» — не память
    after = re.sub(re.escape(color), " ", after, flags=re.I)
    config = mac_config(after)
    if not config:
        return None
    # У MacBook Pro тёмный цвет один — Space Black; «Black» в прайсе — он же,
    # и без склейки на экране стояли бы два одинаковых кружка.
    if m["line"].lower() == "pro" and color.strip().lower() == "black":
        color = "Space Black"
    return f"Apple MacBook {m['line'].title()} {m['size']} {chip_name}", {
        "Цвет": color, "Конфигурация": config}


_IMAC = re.compile(r"^Apple iMac (?P<chip>M\d)\s*\((?P<cfg>[^)]+)\)\s*(?P<color>[A-Za-z ]+)$")


def _imac(product, clean: str):
    m = _IMAC.match(clean)
    if not m:
        return None
    nums = m["cfg"].split("/")
    if len(nums) == 4:            # CPU/GPU/RAM/SSD
        config = f"{nums[0]}/{nums[1]} · {_gb(nums[2])} · {_storage(nums[3])}"
    elif len(nums) == 3:          # CPU/GPU/SSD — память базовая, не указана
        config = f"{nums[0]}/{nums[1]} · {_storage(nums[2])}"
    else:
        return None
    return f"Apple iMac {m['chip']}", {"Цвет": m["color"].strip(), "Конфигурация": config}


_MACMINI = re.compile(r"^Apple Mac (?P<kind>Mini|Studio) (?P<chip>M\d(?: (?:Pro|Max|Ultra))?)\s+(?P<rest>.+)$", re.I)


def _mac_desktop(product, clean: str):
    m = _MACMINI.match(clean)
    if not m:
        return None
    rest = m["rest"].strip("() ")
    if re.search(r"GBE|Ethernet", rest, re.I):
        rest = re.sub(r"/?\d+\s*GBE", "", rest, flags=re.I)
    config = mac_config(rest)
    if not config:
        return None
    kind = "mini" if m["kind"].lower() == "mini" else "Studio"
    return f"Apple Mac {kind} {m['chip']}", {"Конфигурация": config}


_AIRPODS_MAX = re.compile(r"^(?P<model>Apple AirPods Max 20\d\d)\s+(?P<color>[A-Za-z ]+)$")


def _airpods(product, clean: str):
    m = _AIRPODS_MAX.match(clean)
    if not m:
        return None
    return m["model"], {"Цвет": _color_from(product, m["color"])}


_DYSON_HAIR = re.compile(r"^Dyson (?:Supersonic |Airwrap |Corrale )?(?P<code>H[DST]\d{2})\b(?P<rest>.*)$")


def _dyson(product, clean: str):
    m = _DYSON_HAIR.match(clean)
    if not m:
        return None
    rest = m["rest"]
    if re.search(r"без кейса|diffuse|\+", rest, re.I):
        return None          # нестандартная комплектация — отдельным товаром
    with_case = bool(re.search(r"\bcase\b|кейс", rest, re.I))
    text = re.sub(r"\(?\bcase\b\)?", " ", rest, flags=re.I)
    text = re.sub(r"\s+", " ", text.replace("/", " ")).strip()
    color = (getattr(product, "color", None) or text).replace("/", " ").strip()
    if not color:
        return None
    return f"Dyson {m['code']}", {"Цвет": re.sub(r"\s+", " ", color),
                                 "Комплектация": "С кейсом" if with_case else "Стандартная"}


_PS_ACC = re.compile(r"^(?P<model>Sony DualSense|PlayStation 5 Pulse Elite|PlayStation 5 Portal)\s+(?:PS5\s+)?(?P<color>[A-Za-z ]+)$")


def _playstation(product, clean: str):
    m = _PS_ACC.match(clean)
    if not m or m["color"].lower().startswith("edge"):
        return None
    return m["model"], {"Цвет": _color_from(product, m["color"])}


_RULES = (_iphone, _ipad, _macbook, _imac, _mac_desktop, _airpods, _dyson, _playstation)


#: Витринный образец iPhone: не вариант нового аппарата, но и не одиночка —
#: у BSA их по десятку на модель, и россыпью они занимали полкаталога.
_SHOWCASE = re.compile(r"\s*\[ASIS\]", re.I)
SHOWCASE_SUFFIX = " — витринный образец"


def resolve(product) -> Resolved | None:
    """Товар -> модель, оси и регион. None — товар остаётся одиночкой."""
    title = getattr(product, "title", None)
    if not title:
        return None
    showcase = bool(_SHOWCASE.search(title)) and "iphone" in title.lower()
    if showcase:
        title = _SHOWCASE.sub("", title)
    if _ONE_OFF.search(title):
        return None
    regions, clean = split_region_codes(title)
    clean = re.sub(r"\s+", " ", clean).strip()
    if showcase:
        got = _iphone(product, clean)
        if not got:
            return None
        family, variant = got
        ordered = {k: variant[k] for k in AXIS_ORDER if variant.get(k)}
        return Resolved(family=family + SHOWCASE_SUFFIX, variant=ordered, regions=regions)
    for rule in _RULES:
        got = rule(product, clean)
        if got:
            family, variant = got
            ordered = {k: variant[k] for k in AXIS_ORDER if variant.get(k)}
            return Resolved(family=family, variant=ordered, regions=regions)
    return None
