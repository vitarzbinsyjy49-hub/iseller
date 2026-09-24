"""Варианты одной модели: одна карточка вместо сорока.

Прайс поставщика заводит товар на каждую комбинацию память × цвет × SIM ×
регион: у iPhone 18 Pro это 40 позиций. Покупателю столько карточек не нужно —
он выбирает модель, а память, цвет и SIM переключает уже внутри. Поэтому:

* **семейство** — модель без памяти, цвета, SIM и региона («Apple iPhone 18
  Pro»). Витринный образец (`[ASIS]`) — отдельное семейство: это другое
  предложение, а не «тот же аппарат дешевле»;
* в выдаче (каталог, поиск, главная) семейство занимает ОДНО место — там, где
  встретился первый его вариант, а показывается самый дешёвый в наличии;
* на странице товара переключатели «Память / Цвет / SIM» ведут на соседний
  товар того же семейства. Регион не переключатель: из одинаковых версий
  по умолчанию берётся самая дешёвая, остальные — «другие версии».

Всё выводится из НАЗВАНИЯ, отдельной таблицы вариантов нет — та же логика, что
у категорий (services/catalog_nav): второе хранилище одного и того же факта
разъехалось бы с первым. Название, которое не разбирается (Mac, консоли,
Dyson), просто не группируется — товар остаётся одиночкой, как раньше.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.product import Product
from app.services.price_posts import split_region_codes

#: «Apple iPhone 18 Pro 256 ГБ Glacier [ASIS] (SIM+eSIM)»: модель, память,
#: цвет, пометки в квадратных скобках, SIM в круглых. Регион к этому моменту
#: уже снят split_region_codes.
_TITLE_RE = re.compile(
    r"^(?P<model>.+?)\s+(?P<storage>\d+\s?(?:ГБ|ТБ))\s+(?P<color>[^\[\]()]+?)"
    r"(?:\s+\[(?P<flags>[^\]]+)\])?(?:\s+\((?P<sim>[^)]*)\))?\s*$",
    re.IGNORECASE,
)

#: Порядок SIM в переключателе: физическая SIM — привычный вариант.
_SIM_ORDER = {"SIM+eSIM": 0, "eSIM": 1, "": 2}


@dataclass
class Axes:
    model: str
    storage: str
    color: str
    sim: str
    regions: list[str] = field(default_factory=list)
    flags: str = ""

    @property
    def family(self) -> str:
        return f"{self.model} [{self.flags}]" if self.flags else self.model


def parse_axes(title: str | None) -> Axes | None:
    """Название -> оси варианта. None, если название не про вариант модели."""
    if not title:
        return None
    regions, clean = split_region_codes(title)
    match = _TITLE_RE.match(clean.strip())
    if not match or "iphone" not in match["model"].lower():
        # Пока только iPhone: у остальных названий память/цвет пишутся как
        # попало («(16/256)», «2 TB»), и неверная склейка разных товаров в
        # одну карточку хуже, чем отсутствие переключателя.
        return None
    return Axes(
        model=match["model"].strip(),
        storage=re.sub(r"\s+", " ", match["storage"]).upper(),
        color=match["color"].strip(),
        sim=(match["sim"] or "").strip(),
        regions=regions,
        flags=(match["flags"] or "").strip(),
    )


def family_of(product: Product) -> str | None:
    axes = parse_axes(product.title)
    return axes.family if axes else None


def _storage_rank(storage: str) -> float:
    number, unit = storage.split()
    return float(number) * (1024 if unit.upper() == "ТБ" else 1)


def _rank(product: Product) -> tuple:
    """Меньше = лучше представитель: в наличии -> дешевле -> стабильный id."""
    return (0 if product.in_stock else 1, float(product.price or 0), product.id)


def collapse(products: list[Product]) -> tuple[list[Product], dict[int, dict]]:
    """Свернуть выдачу до одной карточки на семейство.

    Порядок сохраняется: семейство стоит там, где встретился первый его
    вариант (ранжирование уже решило, где ему место), а на это место встаёт
    лучший представитель. Возвращает список и {id представителя: сводка}.
    Сводка — сколько вариантов, минимальная цена В НАЛИЧИИ, какие цвета.
    """
    out: list[Product] = []
    slot: dict[str, int] = {}
    members: dict[str, list[Product]] = {}
    for product in products:
        family = family_of(product)
        if family is None:
            out.append(product)
            continue
        members.setdefault(family, []).append(product)
        if family in slot:
            index = slot[family]
            if _rank(product) < _rank(out[index]):
                out[index] = product
        else:
            slot[family] = len(out)
            out.append(product)

    info: dict[int, dict] = {}
    for family, group in members.items():
        if len(group) < 2:
            continue
        rep = out[slot[family]]
        available = [p for p in group if p.in_stock] or group
        colors = sorted({parse_axes(p.title).color for p in group})
        info[rep.id] = {
            "model": parse_axes(rep.title).family,
            "count": len(group),
            "min_price": min(float(p.price) for p in available),
            "colors": colors,
        }
    return out, info


def apply_family_info(cards: list[dict], info: dict[int, dict]) -> None:
    """Приклеить сводку семейства к карточкам (поле `family`)."""
    for card in cards:
        if card.get("id") in info:
            card["family"] = info[card["id"]]


def variants_payload(db: Session, product: Product) -> dict | None:
    """Варианты для страницы товара. None — переключать не на что."""
    axes = parse_axes(product.title)
    if axes is None:
        return None
    from app.services.marketplace import MARKETPLACE_SOURCE

    candidates = (db.query(Product)
                  .filter(Product.is_active.is_(True),
                          Product.source.is_distinct_from(MARKETPLACE_SOURCE),
                          Product.title.like(axes.model + " %"))
                  .all())
    options = []
    for candidate in candidates:
        other = parse_axes(candidate.title)
        if other is None or other.family != axes.family:
            continue
        options.append({
            "id": candidate.id,
            "storage": other.storage,
            "color": other.color,
            "sim": other.sim,
            "regions": other.regions,
            "price": float(candidate.price),
            "in_stock": bool(candidate.in_stock),
        })
    if len(options) < 2:
        return None
    options.sort(key=lambda o: (_storage_rank(o["storage"]), o["color"],
                                _SIM_ORDER.get(o["sim"], 3), o["price"], o["id"]))
    return {
        "axes": {
            "storage": sorted({o["storage"] for o in options}, key=_storage_rank),
            "color": sorted({o["color"] for o in options}),
            "sim": sorted({o["sim"] for o in options}, key=lambda s: _SIM_ORDER.get(s, 3)),
        },
        "current": {"storage": axes.storage, "color": axes.color, "sim": axes.sim,
                    "regions": axes.regions},
        "options": options,
    }
