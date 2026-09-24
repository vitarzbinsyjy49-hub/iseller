"""Варианты одной модели: одна карточка вместо сорока.

Прайс поставщика заводит товар на каждую комбинацию память × цвет × SIM ×
регион: у iPhone 18 Pro это 40 позиций, у iMac M4 — 29. Покупателю столько
карточек не нужно — он выбирает модель, а остальное переключает внутри:

* **семейство** (`family_key`) — модель без памяти, цвета, SIM и региона;
* **оси** (`variant`) — чем товар отличается от соседей: {"Цвет": "Silver",
  "Память": "256 ГБ"}. Набор осей у каждой линейки свой (у Mac —
  «Конфигурация», у iPad — «Связь»), экран строит ряды из того, что пришло;
* в выдаче (каталог, поиск, главная) семейство занимает ОДНО место — там, где
  встретился первый его вариант, а показывается самый дешёвый в наличии;
* регион — не ось: из одинаковых по осям версий по умолчанию берётся самая
  дешёвая, остальные — «другие версии».

Откуда берутся семейство и оси: сохранённые в товаре значения главнее (их
можно поправить в админке), а где их нет — правила по линейкам
(services/family_rules). Отдельной таблицы вариантов нет — та же логика, что
у категорий (services/catalog_nav): второе хранилище одного факта разъехалось
бы с первым.
"""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from app.models.product import Product
from app.services.family_rules import AXIS_ORDER, resolve
from app.services.price_posts import split_region_codes

COLOR_AXIS = "Цвет"


def family_and_variant(product: Product) -> tuple[str, dict[str, str]] | None:
    """(семейство, оси) товара. None — товар одиночка."""
    stored_family = getattr(product, "family_key", None)
    stored_variant = getattr(product, "variant", None)
    if stored_family and stored_variant:
        return stored_family, dict(stored_variant)
    got = resolve(product)
    if got is None:
        return None
    return stored_family or got.family, got.variant


def family_of(product: Product) -> str | None:
    fv = family_and_variant(product)
    return fv[0] if fv else None


def _rank(product: Product) -> tuple:
    """Меньше = лучше представитель: в наличии -> дешевле -> стабильный id."""
    return (0 if product.in_stock else 1, float(product.price or 0), product.id)


def card_key(family: str, variant: dict[str, str]) -> str:
    """Ключ карточки в выдаче: модель + цвет (решение владельца 24.09.2026).

    Цвет выбирают глазами — он виден на фото, и «iPhone 18 Pro Burgundy»
    отдельной карточкой продаёт лучше, чем кружок внутри. Память, SIM,
    конфигурация — выбор «по таблице», он живёт внутри карточки. У линейки без
    цвета (Mac mini) карточка — модель целиком."""
    color = variant.get(COLOR_AXIS)
    return f"{family} {color}" if color else family


def collapse(products: list[Product]) -> tuple[list[Product], dict[int, dict]]:
    """Свернуть выдачу до одной карточки на модель + цвет.

    Модель стоит там, где встретился первый её вариант (ранжирование уже
    решило, где ей место), и все её цвета идут ПОДРЯД — вперемешку с другими
    моделями они читались бы как случайный набор. Представитель цвета — лучший
    вариант (в наличии, дешевле). Возвращает список и {id представителя:
    сводка}; сводка только у карточек, за которыми больше одного товара.
    """
    order: list = []                       # Product-одиночки и ключи моделей
    seen_family: set[str] = set()
    cards_of: dict[str, list[str]] = {}    # модель -> ключи карточек по порядку
    best: dict[str, Product] = {}
    members: dict[str, list[Product]] = {}
    for product in products:
        fv = family_and_variant(product)
        if fv is None:
            order.append(product)
            continue
        family, variant = fv
        key = card_key(family, variant)
        if family not in seen_family:
            seen_family.add(family)
            order.append(("family", family))
        if key not in members:
            cards_of.setdefault(family, []).append(key)
            members[key] = []
            best[key] = product
        members[key].append(product)
        if _rank(product) < _rank(best[key]):
            best[key] = product

    out: list[Product] = []
    for item in order:
        if isinstance(item, tuple):
            out.extend(best[key] for key in cards_of[item[1]])
        else:
            out.append(item)

    info: dict[int, dict] = {}
    for key, group in members.items():
        if len(group) < 2:
            continue
        info[best[key].id] = _summary(key, group)
    return out, info


def _summary(key: str, group: list[Product]) -> dict:
    available = [p for p in group if p.in_stock] or group
    return {
        "model": key,
        "count": len(group),
        "min_price": min(float(p.price) for p in available),
        # Кружки цветов не нужны: карточка уже про один цвет. Поле оставлено
        # для линеек, где цвет не ось (пусто) — фронт рисует кружки при > 1.
        "colors": [],
    }


def whole_family_info(db: Session, info: dict[int, dict]) -> dict[int, dict]:
    """Пересчитать сводки по ВСЕМ активным товарам той же модели и цвета.

    `collapse` видит только то, что попало в выдачу: секция «Горячее» — лишь
    часть вариантов, и «от X ₽» на карточке выходил бы выше настоящей цены,
    а «N вариантов» — меньше. Один запрос на все карточки сразу.
    """
    if not info:
        return info
    from app.services.marketplace import MARKETPLACE_SOURCE

    wanted = {summary["model"] for summary in info.values()}
    groups: dict[str, list[Product]] = {}
    rows = (db.query(Product)
            .filter(Product.is_active.is_(True),
                    Product.source.is_distinct_from(MARKETPLACE_SOURCE))
            .all())
    for row in rows:
        fv = family_and_variant(row)
        if fv:
            key = card_key(*fv)
            if key in wanted:
                groups.setdefault(key, []).append(row)
    return {rep_id: (_summary(summary["model"], groups[summary["model"]])
                     if len(groups.get(summary["model"]) or []) >= 2 else summary)
            for rep_id, summary in info.items()}


def apply_family_info(cards: list[dict], info: dict[int, dict],
                      db: Session | None = None) -> None:
    """Приклеить сводку семейства к карточкам (поле `family`).

    С `db` сводка пересчитывается по всему семейству (см. whole_family_info)."""
    if db is not None:
        info = whole_family_info(db, info)
    for card in cards:
        if card.get("id") in info:
            card["family"] = info[card["id"]]


def _value_rank(axis: str, value: str) -> tuple:
    """Порядок значений в ряду: объёмы — по возрастанию, SIM — физическая
    первой, остальное — по алфавиту."""
    m = re.search(r"(\d+)\s*(ГБ|ТБ)\s*$", value)
    if m and axis in ("Память", "Конфигурация"):
        size = int(m.group(1)) * (1024 if m.group(2) == "ТБ" else 1)
        return (0, size, value)
    if axis == "SIM":
        return (0, {"SIM+eSIM": 0, "eSIM": 1}.get(value, 2), value)
    return (1, 0, value)


def variants_payload(db: Session, product: Product) -> dict | None:
    """Варианты для страницы товара. None — переключать не на что.

    `axes` — только оси, по которым варианты действительно различаются: ряд из
    одной кнопки ничего не выбирает. Если различается только регион, осей нет,
    но payload есть — экран покажет «другие версии»."""
    fv = family_and_variant(product)
    if fv is None:
        return None
    family, current = fv
    from app.services.marketplace import MARKETPLACE_SOURCE

    # Кандидаты — все активные товары; семейство считается в Python, потому что
    # у части товаров оно не сохранено и выводится правилами. Каталог — сотни
    # позиций, это дешевле, чем держать второй путь в SQL.
    candidates = (db.query(Product)
                  .filter(Product.is_active.is_(True),
                          Product.source.is_distinct_from(MARKETPLACE_SOURCE))
                  .all())
    options = []
    for candidate in candidates:
        other = family_and_variant(candidate)
        if other is None or other[0] != family:
            continue
        options.append({
            "id": candidate.id,
            "values": other[1],
            "regions": split_region_codes(candidate.title)[0],
            "price": float(candidate.price),
            "in_stock": bool(candidate.in_stock),
        })
    if len(options) < 2:
        return None

    names = [a for a in AXIS_ORDER if any(a in o["values"] for o in options)]
    names += sorted({a for o in options for a in o["values"]} - set(names))
    axes = []
    for name in names:
        values = sorted({o["values"][name] for o in options if name in o["values"]},
                        key=lambda v: _value_rank(name, v))
        if len(values) > 1:
            axes.append({"name": name, "values": values})
    options.sort(key=lambda o: (tuple(_value_rank(a["name"], o["values"].get(a["name"], ""))
                                      for a in axes), o["price"], o["id"]))
    return {
        "axes": axes,
        "current": {"values": current, "regions": split_region_codes(product.title)[0]},
        "options": options,
    }
