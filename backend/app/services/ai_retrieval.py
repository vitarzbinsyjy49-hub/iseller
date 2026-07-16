"""Retrieval + ranking кандидатов для локального AI-консультанта (v5).

Принцип: LLM не ищет по каталогу. Backend сам извлекает фильтры из текста,
делает жёсткую фильтрацию в PostgreSQL и мягкий ranking в Python, после чего
отдаёт модели МАКСИМУМ AI_MAX_PRODUCT_CANDIDATES компактных кандидатов.
Никогда не отправляем весь каталог и описания товаров (описания — недоверенный
текст, лишние токены и поверхность для injection).
"""
import re
from dataclasses import dataclass, field

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.catalog import _alias, search_products  # переиспользуем алиасы live-поиска
from app.models.product import Product
from app.services.ai_provider import _extract_price_max, _detect_category

# Бренды каталога: расширяемый словарь «как пишут -> как в БД»
_BRAND_HINTS = {
    "apple": "Apple", "эпл": "Apple", "iphone": "Apple", "айфон": "Apple", "macbook": "Apple",
    "samsung": "Samsung", "самсунг": "Samsung",
    "xiaomi": "Xiaomi", "сяоми": "Xiaomi", "ксиаоми": "Xiaomi",
    "sony": "Sony", "сони": "Sony", "playstation": "Sony",
    "dyson": "Dyson", "дайсон": "Dyson",
    "lenovo": "Lenovo", "леново": "Lenovo",
    "asus": "ASUS", "асус": "ASUS",
    "jbl": "JBL",
    "nintendo": "Nintendo", "нинтендо": "Nintendo",
}

_USE_CASE_KEYWORDS = {
    "video_editing": ("монтаж", "монтир", "premiere", "davinci", "рендер"),
    "gaming": ("игр", "гейм", "gaming", "киберспорт"),
    "study": ("учеб", "учёб", "студент", "школ"),
    "work": ("работ", "офис", "таблиц", "документ"),
    "gift": ("подар", "девушк", "жене", "мужу", "ребенк", "ребёнк", "сыну", "дочер"),
    "photo": ("фото", "обработк", "lightroom"),
    "travel": ("поездк", "путешеств", "дорог", "лёгк", "легк", "компакт"),
}

_CONDITION_HINTS = {
    "used": ("б/у", "бу ", "б.у", "подержан"),
    "refurbished": ("восстановлен", "refurb", "как новый"),
    "new": ("новый", "новую", "только новое"),
}


@dataclass
class ExtractedFilters:
    """Детерминированно извлечённые фильтры — считаем их надёжнее, чем мнение LLM."""
    budget_max: float | None = None
    category: str | None = None
    brand: str | None = None
    condition: str | None = None
    use_cases: list[str] = field(default_factory=list)
    in_stock_only: bool = False

    def to_state(self) -> dict:
        """conversation state для фронта/логов (без чувствительных данных)."""
        return {
            "budget_max": self.budget_max, "category": self.category,
            "brand": self.brand, "condition": self.condition,
            "use_cases": self.use_cases, "in_stock_only": self.in_stock_only,
        }


def extract_filters(message: str, history: list[str] | None = None) -> ExtractedFilters:
    """Извлечь фильтры из текущего сообщения + истории (свежие сообщения главнее).

    history — только тексты пользователя, от старых к новым. Более новое
    упоминание бюджета/категории перекрывает старое.
    """
    f = ExtractedFilters()
    texts = [*(history or []), message]  # старые -> новые; новые перезаписывают
    for text in texts:
        low = text.lower()
        budget = _extract_price_max(text)
        if budget:
            f.budget_max = budget
        category = _detect_category(text)
        if category:
            f.category = category
        for kw, brand in _BRAND_HINTS.items():
            if kw in low:
                f.brand = brand
                break
        for cond, kws in _CONDITION_HINTS.items():
            if any(k in low for k in kws):
                f.condition = cond
                break
        for case, kws in _USE_CASE_KEYWORDS.items():
            if any(k in low for k in kws) and case not in f.use_cases:
                f.use_cases.append(case)
        if "в наличии" in low or "сегодня" in low:
            f.in_stock_only = True
    return f


def _score(p: Product, f: ExtractedFilters) -> float:
    """Мягкий ranking. Жёсткие фильтры уже применены в SQL."""
    score = 0.0
    if p.in_stock:
        score += 30
        if p.is_available_today:
            score += 6
    score += min(float(p.popularity or 0), 20)
    score += min(float(p.rating or 0) * 2, 10)
    # близость к бюджету: лучший вариант ~70-100% бюджета, не «самый дешёвый»
    if f.budget_max:
        ratio = float(p.price) / f.budget_max
        if 0.55 <= ratio <= 1.0:
            score += 12
        elif ratio < 0.35:
            score -= 4
    # сценарии использования: премируем заполненные профильные характеристики
    if "video_editing" in f.use_cases or "gaming" in f.use_cases:
        if p.cpu:
            score += 5
        if p.ram:
            score += 4
        if p.screen_size:
            score += 2
    # качество данных: карточка с характеристиками полезнее для честного ответа
    filled = sum(1 for v in (p.memory, p.storage, p.cpu, p.ram, p.screen_size, p.color) if v)
    score += min(filled, 5)
    if p.image:
        score += 1
    return score


def retrieve_candidates(db: Session, message: str, f: ExtractedFilters, limit: int = 12) -> list[Product]:
    """Жёсткие фильтры в SQL -> объединение с текстовым поиском -> мягкий ranking."""
    # 1) текстовый поиск по словам запроса (та же логика, что live-поиск)
    by_words = search_products(db, message, f.budget_max, limit=limit * 2)

    # 2) структурный запрос по извлечённым фильтрам
    stmt = select(Product).where(Product.is_active.is_(True))
    if f.category:
        stmt = stmt.where(Product.category == f.category)
    if f.budget_max:
        stmt = stmt.where(Product.price <= f.budget_max)
    if f.brand:
        stmt = stmt.where(or_(Product.brand.ilike(f"%{f.brand}%"), Product.title.ilike(f"%{f.brand}%")))
    if f.condition:
        stmt = stmt.where(Product.condition == f.condition)
    if f.in_stock_only:
        stmt = stmt.where(Product.in_stock.is_(True))
    structural = list(db.execute(stmt.limit(limit * 3)).scalars().all())

    # 3) объединяем без дублей; структурные результаты первичны при пустом поиске
    seen: set[int] = set()
    merged: list[Product] = []
    for p in [*by_words, *structural]:
        if p.id not in seen:
            seen.add(p.id)
            merged.append(p)

    merged.sort(key=lambda p: _score(p, f), reverse=True)
    return merged[:limit]


_WS_RE = re.compile(r"\s+")


def candidate_payload(products: list[Product]) -> list[dict]:
    """Компактный контекст для LLM. Только структурированные поля из БД.

    Описания НЕ включаем: они недоверенные (могут содержать инструкции) и
    раздувают контекст. Цена/наличие здесь только для рассуждений модели —
    пользователю всё равно уходят значения из БД через to_card().
    """
    out = []
    for p in products:
        specs = {k: str(v)[:60] for k, v in list((p.specs or {}).items())[:4]}
        out.append({
            "id": p.id,
            "title": _WS_RE.sub(" ", p.title)[:120],
            "brand": p.brand, "category": p.category,
            "price": float(p.price),
            "old_price": float(p.old_price) if p.old_price is not None else None,
            "in_stock": p.in_stock, "stock": p.stock,
            "condition": p.condition,
            "memory": p.memory, "ram": p.ram, "storage": p.storage,
            "cpu": p.cpu, "screen_size": p.screen_size, "color": p.color,
            "warranty_months": p.warranty_months,
            "tags": (p.tags or [])[:5],
            "specs": specs,
        })
    return out
