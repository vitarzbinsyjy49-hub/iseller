"""AI provider для демо.

Задача — чтобы демо всегда давало осмысленный, «AI-подобный» ответ, даже без
Ollama и без облачных ключей. Здесь НЕТ обращения к LLM: ответ формируется
правилами по каталогу. Это честный fallback/mock:
- бюджет и категория извлекаются из текста;
- карточки и цены берутся ТОЛЬКО из БД (никаких выдуманных товаров/цен);
- если ничего не найдено — честно говорим и предлагаем изменить бюджет.

meta.source для таких ответов = "fallback" (движок не использовался).
Когда AI Engine доступен и AI_PROVIDER=ai — используется он (см. api/ai.py),
и source становится "ai".
"""
import re
import time

from sqlalchemy.orm import Session

from app.api.catalog import search_products

# Приоритетно: число рядом с «до …» или с суффиксом тыс/к/000.
_PRICE_CTX_RE = re.compile(r"до\s*(\d[\d\s]*)\s*(тыс|т\.|k|к|000)?|(\d[\d\s]*)\s*(тыс|т\.|k|к|000)", re.IGNORECASE)

# Ключевые слова -> категория каталога
_CATEGORY_HINTS = {
    "ноутбук": "ноутбуки", "ноут": "ноутбуки", "макбук": "ноутбуки", "macbook": "ноутбуки",
    "laptop": "ноутбуки", "монтаж": "ноутбуки", "игровой": "ноутбуки",
    "смартфон": "смартфоны", "телефон": "смартфоны", "айфон": "смартфоны", "iphone": "смартфоны",
    "samsung": "смартфоны", "самсунг": "смартфоны", "xiaomi": "смартфоны",
    "планшет": "планшеты", "ipad": "планшеты", "айпад": "планшеты",
    "наушник": "наушники", "airpods": "наушники", "аирподс": "наушники", "гарнитур": "наушники",
    "консол": "консоли", "playstation": "консоли", "ps5": "консоли", "xbox": "консоли",
    "приставка": "консоли", "switch": "консоли", "нинтендо": "консоли",
    "dyson": "dyson", "дайсон": "dyson", "фен": "dyson", "стайлер": "dyson", "airwrap": "dyson",
    "часы": "аксессуары", "watch": "аксессуары", "зарядк": "аксессуары", "кабел": "аксессуары",
    "чехол": "аксессуары", "powerbank": "аксессуары", "павербанк": "аксессуары",
}

_USE_CASE_HINTS = {
    "монтаж": "для монтажа видео важны производительный процессор и хороший экран",
    "игр": "для игр смотрите на дискретную видеокарту и частоту экрана",
    "учеб": "для учёбы хватит лёгкой модели с долгой автономностью",
    "работ": "для работы важны автономность и удобная клавиатура",
    "подар": "в подарок хорошо заходят популярные модели в наличии",
    "фото": "для фото и обработки важен качественный экран и объём памяти",
}


def _extract_price_max(text: str) -> float | None:
    m = _PRICE_CTX_RE.search(text.lower())
    if not m:
        return None
    # группы 1,2 — вариант «до N [суффикс]»; группы 3,4 — вариант «N суффикс»
    num = m.group(1) or m.group(3)
    suffix = m.group(2) or m.group(4)
    if not num:
        return None
    raw = num.replace(" ", "")
    if not raw.isdigit():
        return None
    value = float(raw)
    if suffix in ("тыс", "т.", "k", "к"):
        value *= 1000
    elif value < 1000:
        # «до 90» разговорно = 90 тысяч
        value *= 1000
    return value


def _detect_category(text: str) -> str | None:
    low = text.lower()
    for kw, cat in _CATEGORY_HINTS.items():
        if kw in low:
            return cat
    return None


def _use_case_note(text: str) -> str | None:
    low = text.lower()
    for kw, note in _USE_CASE_HINTS.items():
        if kw in low:
            return note
    return None


def build_demo_answer(db: Session, message: str, max_cards: int = 6, source: str = "fallback") -> dict:
    """Сформировать demo/fallback-ответ по каталогу. Возвращает контракт {text, cards, actions, meta}.

    source: "fallback" (AI недоступен/выключен) или "mock" (имитация AI для демо) —
    логика одна, отличается только meta.source и тон ответа."""
    t0 = time.monotonic()
    price_max = _extract_price_max(message)
    category = _detect_category(message)

    # Ищем: сначала пробуем по всему запросу, отсекаем по бюджету/категории
    products = search_products(db, message, price_max, limit=max_cards)

    # Если по словам ничего не нашли, но есть категория — берём топ категории в бюджете
    if not products and category:
        from sqlalchemy import select  # локальный импорт, чтобы не тянуть в топ модуля
        from app.models.product import Product
        stmt = select(Product).where(Product.is_active.is_(True), Product.category == category)
        if price_max:
            stmt = stmt.where(Product.price <= price_max)
        stmt = stmt.order_by(Product.in_stock.desc(), Product.popularity.desc()).limit(max_cards)
        products = list(db.execute(stmt).scalars().all())

    latency = int((time.monotonic() - t0) * 1000)
    note = _use_case_note(message)

    if products:
        budget_str = f" до {int(price_max):,}".replace(",", " ") + " ₽" if price_max else ""
        head = ("Подобрал для вас варианты" if source == "mock" else "Вот что подходит") + budget_str
        if category:
            head += f" в категории «{category}»"
        parts = [head + "."]
        if note:
            parts.append(note.capitalize() + ".")
        top = products[0]
        parts.append(
            f"Обратите внимание на «{top.title}» — "
            f"{int(top.price):,}".replace(",", " ") + " ₽"
            + (" (в наличии)." if top.in_stock else " (сейчас нет в наличии).")
        )
        text = " ".join(parts)
    else:
        if price_max:
            text = (f"В бюджете до {int(price_max):,}".replace(",", " ")
                    + " ₽ подходящих товаров не нашлось. Попробуйте немного поднять бюджет "
                    "или выбрать другую категорию — покажу ближайшие варианты.")
        else:
            text = ("Не совсем понял запрос. Опишите категорию и бюджет — например, "
                    "«ноутбук до 120 тысяч для работы», и я подберу варианты.")

    # v5.4.0: карточки AI тоже получают эффективную групповую галерею (карусель),
    # одним батчем через resolver — без N+1.
    from app.services.image_groups import apply_group_images
    cards = [p.to_card() for p in products]
    apply_group_images(db, products, cards)

    return {
        "text": text,
        "cards": cards,
        "actions": [
            {"type": "refine", "label": "Уточнить запрос"},
            {"type": "manager", "label": "Позвать менеджера"},
        ],
        "meta": {
            "source": source,
            "intent": ("recommend" if products else "clarify"),
            "latency_ms": latency,
            "price_max": price_max,
            "category": category,
        },
    }
