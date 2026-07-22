"""Канонические группы изображений по модели и цвету (v5.2.6).

Одна и та же модель одного цвета показывает ОДНУ галерею, независимо от
памяти / накопителя / RAM / SIM / региона / гарантии / цены / SKU. Разные
цвета и разные физические модели (поколение, Pro/Pro Max, размер корпуса) —
разные группы.

    image_group_key = brand | normalized_model | normalized_color

Ничего не «угадываем»: цвет берём из структурного поля color, иначе из title по
СПИСКУ известных цветов; модель — из title (или model_family), вычитая заведомо
варьирующие токены (память/накопитель/RAM/SIM/регион) и значения структурных
полей. Если бренда/модели/цвета недостаточно — ключа НЕТ (товар остаётся на
своих фото). Направление ошибки выбрано безопасным: лучше НЕ объединить (товар
получит свою группу), чем объединить разные модели, поэтому отличающие токены
(число поколения, Pro/Max/Air/Ultra/Plus/Mini, размер, mm/дюймы, чип Mx) мы
СОХРАНЯЕМ.
"""
from __future__ import annotations

import re
import unicodedata

# ---- цвета: синоним (RU/EN) -> канон. Многословные — обрабатываются как фразы ----
_COLOR_CANON: dict[str, str] = {
    "black": "black", "чёрный": "black", "черный": "black", "чёрная": "black", "черная": "black",
    "white": "white", "белый": "white", "белая": "white",
    "silver": "silver", "серебристый": "silver", "серебро": "silver", "серебряный": "silver",
    "space gray": "space gray", "space grey": "space gray",
    "серый космос": "space gray", "космический серый": "space gray",
    "gray": "gray", "grey": "gray", "серый": "gray",
    "graphite": "graphite", "графит": "graphite", "графитовый": "graphite",
    "gold": "gold", "золотой": "gold", "золото": "gold",
    "rose gold": "rose gold", "розовое золото": "rose gold",
    "blue": "blue", "синий": "blue", "голубой": "blue",
    "green": "green", "зелёный": "green", "зеленый": "green",
    "red": "red", "красный": "red",
    "purple": "purple", "фиолетовый": "purple",
    "pink": "pink", "розовый": "pink",
    "yellow": "yellow", "жёлтый": "yellow", "желтый": "yellow",
    "orange": "orange", "оранжевый": "orange",
    "midnight": "midnight", "тёмная ночь": "midnight", "темная ночь": "midnight",
    "starlight": "starlight", "сияющая звезда": "starlight",
    "titanium": "titanium", "титановый": "titanium", "титан": "titanium",
    "natural titanium": "natural titanium", "натуральный титан": "natural titanium",
    "blue titanium": "blue titanium", "синий титан": "blue titanium",
    "white titanium": "white titanium", "белый титан": "white titanium",
    "black titanium": "black titanium", "чёрный титан": "black titanium", "черный титан": "black titanium",
    "desert titanium": "desert titanium", "песочный титан": "desert titanium",
}
# Фразы для поиска в title — длинные раньше коротких («space gray» до «gray»).
_COLOR_PHRASES: list[str] = sorted(_COLOR_CANON, key=len, reverse=True)

# Токены, которые НЕ меняют внешний вид -> вычищаем из модели.
_VARIANT_RE: list[re.Pattern] = [
    re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:гб|gb|gib|тб|tb|мб|mb)\b"),   # 128 ГБ, 1 ТБ, 256 GB
    re.compile(r"\b\d{1,3}\s*/\s*\d{2,4}\b"),                          # 8/256, 16/256 (RAM/SSD)
    re.compile(r"\b(?:dual\s*sim|nano-?sim|e-?sim|sim)\b"),
    re.compile(r"\b(?:ll|zp|ch|j|ru|zа|za|mg|aa)\s*/\s*a\b"),         # региональные коды LL/A, ZP/A
    re.compile(r"\b(?:ростест|rostest|eac|global|глобал|рст)\b"),
]

_DASH_RE = re.compile(r"[‐-―−]")   # разные тире -> обычный дефис
_SPACE_RE = re.compile(r"\s+")
_WORD = "0-9a-zа-яё"   # границы слова для латиницы+кириллицы


def _norm(s) -> str:
    if s is None:
        return ""
    s = unicodedata.normalize("NFC", str(s)).lower()
    s = _DASH_RE.sub("-", s)
    return _SPACE_RE.sub(" ", s).strip()


def _remove_phrase(s: str, phrase: str) -> str:
    """Удалить вхождения phrase как отдельного «слова/фразы» (не внутри слова)."""
    if not phrase:
        return s
    return re.sub(rf"(?<![{_WORD}]){re.escape(phrase)}(?![{_WORD}])", " ", s)


def _collapse(s: str) -> str:
    s = _SPACE_RE.sub(" ", s).strip()
    return s.strip(" -_/·,")


def normalize_color(color, title: str | None = None) -> str | None:
    """Канонический цвет из поля color, иначе из title по списку известных
    цветов. Неизвестный непустой color — используется как есть (тоже группирует).
    Нет ни поля, ни известной фразы в title -> None (товар не группируется)."""
    c = _norm(color)
    if c:
        return _COLOR_CANON.get(c, c)
    if title:
        t = _norm(title)
        for phrase in _COLOR_PHRASES:
            if re.search(rf"(?<![{_WORD}]){re.escape(phrase)}(?![{_WORD}])", t):
                return _COLOR_CANON[phrase]
    return None


def normalize_model(base, *, color_raw=None, memory=None, storage=None, ram=None) -> str:
    """Каноническая модель: title/model_family минус цвет и варьирующие токены."""
    s = _norm(base)
    if not s:
        return ""
    # убрать значение поля color и все известные цветовые фразы
    for phrase in ([_norm(color_raw)] if color_raw else []) + _COLOR_PHRASES:
        s = _remove_phrase(s, phrase)
    # убрать значения структурных варьирующих полей
    for val in (memory, storage, ram):
        s = _remove_phrase(s, _norm(val))
    # убрать варьирующие паттерны (память/накопитель/RAM/SIM/регион)
    for rx in _VARIANT_RE:
        s = rx.sub(" ", s)
    return _collapse(s)


def image_group_key(
    brand, title, *, color=None, model_family=None, memory=None, storage=None, ram=None
) -> str | None:
    """brand|model|color или None, если данных для устойчивого ключа не хватает."""
    b = _norm(brand)
    col = normalize_color(color, title)
    if not b or not col:
        return None
    model = normalize_model(model_family or title, color_raw=color,
                            memory=memory, storage=storage, ram=ram)
    if len(model) < 2:
        return None
    return f"{b}|{model}|{col}"


def product_image_group_key(product) -> str | None:
    """image_group_key для ORM-товара (читает его поля)."""
    return image_group_key(
        product.brand, product.title,
        color=product.color,
        model_family=getattr(product, "model_family", None),
        memory=product.memory, storage=product.storage, ram=product.ram,
    )


# ==================== resolver галерей (runtime) ====================

def _own_images(obj) -> list[str]:
    """Свои фото товара/группы: главная image впереди, без дублей."""
    imgs = [u for u in (getattr(obj, "images", None) or []) if u]
    main = getattr(obj, "image", None)
    if main and main not in imgs:
        imgs = [main, *imgs]
    return imgs


def resolve_product_images(db, products) -> dict[int, dict]:
    """Эффективная галерея каждого товара: {product_id: {"image", "images"}}.

    Порядок источников (spec 1.4), безопасный и обратно совместимый:
      1) canonical-группа по image_group_key (если товар не detached и у группы
         есть фото) — так все варианты модели+цвета показывают одно;
      2) свои image/images товара (легаси / detached);
      3) фото товара-соседа той же группы (у кого они есть);
      4) пусто -> вызывающий код/фронт показывает нейтральный placeholder.

    Батч: 1 запрос групп + максимум 1 запрос соседей. Без N+1 и без похода в БД
    на каждую карточку.
    """
    from sqlalchemy import select
    from app.models.product import Product
    from app.models.product_image_group import ProductImageGroup

    products = list(products)
    if not products:
        return {}

    keys = {p.image_group_key for p in products
            if p.image_group_key and not p.image_group_detached}
    groups: dict[str, object] = {}
    if keys:
        rows = db.execute(select(ProductImageGroup).where(ProductImageGroup.key.in_(keys))).scalars().all()
        groups = {g.key: g for g in rows}

    result: dict[int, dict] = {}
    need_sibling: set[str] = set()
    for p in products:
        g = groups.get(p.image_group_key) if not p.image_group_detached else None
        gimgs = _own_images(g) if g is not None else []
        if gimgs:
            result[p.id] = {"image": gimgs[0], "images": gimgs}
            continue
        oimgs = _own_images(p)
        if oimgs:
            result[p.id] = {"image": oimgs[0], "images": oimgs}
            continue
        result[p.id] = {"image": None, "images": []}
        if p.image_group_key and not p.image_group_detached:
            need_sibling.add(p.image_group_key)

    if need_sibling:
        sib_rows = db.execute(
            select(Product)
            .where(Product.image_group_key.in_(need_sibling), Product.is_active.is_(True))
            .order_by(Product.in_stock.desc(), Product.popularity.desc(), Product.id.asc())
        ).scalars().all()
        sib_by_key: dict[str, list[str]] = {}
        for s in sib_rows:
            simgs = _own_images(s)
            if simgs and s.image_group_key not in sib_by_key:
                sib_by_key[s.image_group_key] = simgs
        for p in products:
            if result[p.id]["images"] or p.image_group_key not in sib_by_key:
                continue
            simgs = sib_by_key[p.image_group_key]
            result[p.id] = {"image": simgs[0], "images": simgs}

    return result


def apply_group_images(db, products, cards) -> list[dict]:
    """Проставить в готовые card/detail-словари эффективную галерею из resolver.
    Работает и для to_card (только image), и для to_detail (image + images)."""
    resolved = resolve_product_images(db, products)
    for p, c in zip(products, cards):
        r = resolved.get(p.id)
        if r is None:
            continue
        c["image"] = r["image"] or ""
        if "images" in c:
            c["images"] = r["images"]
    return cards


def _representative_rank(p) -> tuple:
    """Меньше = лучше representative: в наличии -> минимальная цена -> популярнее
    -> стабильный id. Память/накопитель не участвуют — варианты не создают дублей."""
    try:
        price = float(p.price or 0)
    except (TypeError, ValueError):
        price = 0.0
    return (0 if p.in_stock else 1, price, -(p.popularity or 0), p.id)


def dedupe_by_group(products) -> list:
    """Оставить один лучший вариант на model+color группу, сохраняя порядок.
    Товары без ключа не группируются (каждый — сам по себе)."""
    out: list = []
    pos: dict[str, int] = {}
    for p in products:
        k = p.image_group_key
        if not k:
            out.append(p)
            continue
        if k in pos:
            i = pos[k]
            if _representative_rank(p) < _representative_rank(out[i]):
                out[i] = p       # лучший representative занимает то же место
        else:
            pos[k] = len(out)
            out.append(p)
    return out
