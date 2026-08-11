"""Разбор прайса поставщика (BSA) в позиции каталога.

Прайс приходит текстом в Telegram и написан для человека, а не для машины:
цена то через дефис вплотную («Blue-99.800»), то через пробел («ASIS 🇺🇸 102 000»),
разряды то точкой, то пробелом, регион — эмодзи-флагами, «e sim» пишется
пятью способами. Поэтому разбор живёт отдельным модулем с тестами: ошибка
здесь — это неверная цена на витрине, а не «съехала вёрстка».

Что делает и чего НЕ делает:

* превращает строку прайса в позицию с ценой, памятью, цветом и регионом;
* регион кладёт КОДАМИ в скобки названия («(HK-KR, SIM+eSIM)») — витрина и
  канал сами покажут его флагом через price_posts.split_region. Обратный
  разбор эмодзи в коды нужен именно поэтому: один формат хранения на всё;
* НЕ считает наценку и НЕ трогает БД — это дело вызывающего скрипта.

Строку, которую разобрать не удалось, модуль не угадывает: она возвращается в
списке `failed`. Молча пропущенная позиция — это товар, который не появится в
каталоге, и заметить это потом можно только по жалобе покупателя.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

#: Эмодзи-флаг -> код страны. Обратная таблица к price_posts.REGION_FLAGS:
#: поставщик пишет флагами, а мы храним кодами в скобках названия.
FLAG_TO_CODE: dict[str, str] = {
    "🇺🇸": "US", "🇭🇰": "HK", "🇮🇳": "IN", "🇯🇵": "JP", "🇰🇷": "KR",
    "🇪🇺": "EU", "🇬🇧": "GB", "🇰🇼": "KW", "🇨🇳": "CN", "🇸🇬": "SG",
    "🇷🇺": "RU", "🇦🇪": "AE", "🇹🇷": "TR", "🇻🇳": "VN", "🇺🇦": "UA",
}

#: Цвета прайса -> как они называются в каталоге. «Mist Blue» и «Blue» у
#: поставщика — один цвет корпуса iPhone 17, фото у них общее.
COLOR_RU: dict[str, str] = {
    "silver": "Silver", "orange": "Orange", "blue": "Blue",
    "black": "Black", "white": "White", "pink": "Pink",
    "sage": "Sage", "lavender": "Lavender", "mist blue": "Blue",
}

_FLAG_RE = re.compile("[\U0001F1E6-\U0001F1FF]{2}")
_PRICE_RE = re.compile(r"(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})")
_MODEL_RE = re.compile(r"^(17 Pro Max|17 Pro|17E|17e|17)\s+(256|512|1TB|2TB)\s+(.+)$", re.I)


@dataclass
class Item:
    model: str          # «17 Pro Max»
    storage: str        # «256 ГБ» / «1 ТБ»
    color: str          # «Blue»
    price: int          # цена поставщика, рублей
    regions: list[str] = field(default_factory=list)   # [«HK», «KR»]
    sim: str = ""       # «SIM+eSIM» / «eSIM»
    asis: bool = False  # витринный образец / уценка
    activated: bool = False   # «актив» — активированный аппарат

    @property
    def title(self) -> str:
        """Название в формате каталога: регион кодами в скобках."""
        parts = []
        if self.regions:
            parts.append("-".join(self.regions))
        if self.sim:
            parts.append(self.sim)
        suffix = f" ({', '.join(parts)})" if parts else ""
        marks = []
        if self.asis:
            marks.append("ASIS")
        if self.activated:
            marks.append("актив")
        mark = f" [{', '.join(marks)}]" if marks else ""
        return f"Apple iPhone {self.model} {self.storage} {self.color}{mark}{suffix}"

    @property
    def sku(self) -> str:
        """Стабильный артикул: по нему импорт находит уже созданный товар."""
        bits = [
            "IP", self.model.replace(" ", ""), self.storage.split()[0],
            self.color, "".join(self.regions) or "NA",
            "ESIM" if self.sim == "eSIM" else "SIM",
        ]
        if self.asis:
            bits.append("ASIS")
        if self.activated:
            bits.append("ACT")
        return "-".join(bits).upper()


def _storage(token: str) -> str:
    token = token.upper()
    if token in ("1TB", "2TB"):
        return f"{token[0]} ТБ"
    return f"{token} ГБ"


#: Ниже этой суммы «цена» — на самом деле не цена. Нужно потому, что разряды
#: в прайсе разделяются пробелом, и «17 256» (модель + память) регулярка
#: читает как число 17256 ровно так же, как «76 000» читает как 76000.
#: Самая дешёвая позиция прайса — 53 000, так что порог с запасом.
_MIN_PRICE = 20_000


def _price_match(text: str) -> re.Match | None:
    """Последнее в строке число, похожее на цену.

    Именно последнее и именно с порогом: слева от цены всегда стоят модель и
    объём памяти, и оба — числа. Поиск слева направо находил «17 256» и на
    всех обычных iPhone 17 разбор разваливался молча.
    """
    best = None
    for match in _PRICE_RE.finditer(text):
        if int(re.sub(r"[.\s]", "", match.group(1))) >= _MIN_PRICE:
            best = match
    return best


def _price(text: str) -> int | None:
    match = _price_match(text)
    return int(re.sub(r"[.\s]", "", match.group(1))) if match else None


def _sim(tail: str) -> str:
    """«(1sim+e sim)» -> «SIM+eSIM», «е sim»/«eSim»/«eSIM» -> «eSIM».

    Внимание: в прайсе встречается и русская «е» в «е sim» — на вид та же
    буква, для машины другая. Ловим обе, иначе половина позиций теряет SIM.
    """
    low = tail.lower().replace("е", "e")
    if "sim+" in low.replace(" ", "") or "1sim" in low.replace(" ", ""):
        return "SIM+eSIM"
    if "esim" in low.replace(" ", "") or "e sim" in low:
        return "eSIM"
    return ""


def parse_line(line: str) -> Item | None:
    """Одна строка прайса -> позиция. None, если это не строка товара."""
    raw = line.strip()
    if not raw or raw.startswith("#"):
        return None

    regions = [FLAG_TO_CODE[f] for f in _FLAG_RE.findall(raw) if f in FLAG_TO_CODE]
    body = _FLAG_RE.sub(" ", raw)

    match = _price_match(body)
    if match is None:
        return None
    price = int(re.sub(r"[.\s]", "", match.group(1)))

    # Отрезаем всё начиная с цены: слева остаётся модель/память/цвет,
    # справа — SIM и пометки.
    left, right = body[:match.start()], body[match.end():]
    left = left.rstrip(" -–—")

    model_match = _MODEL_RE.match(left.strip())
    if not model_match:
        return None
    model_raw, storage_raw, rest = model_match.groups()

    rest_low = rest.lower()
    asis = "asis" in rest_low
    color_key = next((c for c in sorted(COLOR_RU, key=len, reverse=True)
                      if c in rest_low), None)
    if color_key is None:
        return None

    tail = f"{rest} {right}"
    return Item(
        model="17 Pro Max" if model_raw.lower() == "17 pro max"
        else "17 Pro" if model_raw.lower() == "17 pro"
        else "17e" if model_raw.lower() == "17e" else "17",
        storage=_storage(storage_raw),
        color=COLOR_RU[color_key],
        price=price,
        regions=regions,
        sim=_sim(tail),
        asis=asis,
        activated="актив" in tail.lower(),
    )


def parse(text: str) -> tuple[list[Item], list[str]]:
    """Весь прайс -> (позиции, нераспознанные строки товаров).

    Нераспознанным считается только то, что похоже на товар (есть цена), но
    не разобралось: заголовки и пустые строки в отчёт не попадают.
    """
    items: list[Item] = []
    failed: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        item = parse_line(stripped)
        if item is not None:
            items.append(item)
        elif _PRICE_RE.search(_FLAG_RE.sub(" ", stripped)):
            failed.append(stripped)
    return items, failed
