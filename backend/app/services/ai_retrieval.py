"""Retrieval + ranking кандидатов для локального AI-консультанта (v5).

Принцип: LLM не ищет по каталогу. Backend сам извлекает фильтры из текста,
делает жёсткую фильтрацию в PostgreSQL и мягкий ranking в Python, после чего
отдаёт модели МАКСИМУМ AI_MAX_PRODUCT_CANDIDATES компактных кандидатов.
Никогда не отправляем весь каталог и описания товаров (описания — недоверенный
текст, лишние токены и поверхность для injection).
"""
import logging
import re
from dataclasses import dataclass, field

from sqlalchemy import case, func, literal, or_, select
from sqlalchemy.orm import Session

from app.api.catalog import _alias, extract_phrase_tokens, search_products  # переиспользуем алиасы live-поиска
from app.models.product import Product
from app.services.ai_provider import _extract_price_max, _detect_category
from app.services.availability import exclude_preorder
from app.services.marketplace import exclude_marketplace

logger = logging.getLogger("techshop.ai.retrieval")

# Бренды каталога: расширяемый словарь «как пишут -> как в БД»
_BRAND_HINTS = {
    "apple": "Apple", "эпл": "Apple", "iphone": "Apple", "айфон": "Apple",
    "macbook": "Apple", "макбук": "Apple",
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


# «не apple», «без самсунга», «кроме xiaomi» — исключение бренда.
# \b перед группой обязателен: без него хвост обычного слова читался как
# отрицание — «покажи МНЕ айфон» и «при обМЕНЕ apple» давали «не apple» и
# выбрасывали из выдачи весь бренд, то есть почти весь каталог. Держит
# test_negation_needs_word_boundary.
_NEG_BRAND_RE = re.compile(r"\b(?:не|без|кроме|только не)\s+([a-zа-яё]+)", re.IGNORECASE)


@dataclass
class ExtractedFilters:
    """Детерминированно извлечённые фильтры — считаем их надёжнее, чем мнение LLM."""
    budget_max: float | None = None
    category: str | None = None
    brand: str | None = None
    excluded_brands: list[str] = field(default_factory=list)
    condition: str | None = None
    use_cases: list[str] = field(default_factory=list)
    in_stock_only: bool = False

    def to_state(self) -> dict:
        """conversation state для фронта/логов (без чувствительных данных)."""
        return {
            "budget_max": self.budget_max, "category": self.category,
            "brand": self.brand, "excluded_brands": self.excluded_brands,
            "condition": self.condition,
            "use_cases": self.use_cases, "in_stock_only": self.in_stock_only,
        }


def extract_filters(message: str, history: list[str] | None = None,
                    vocab: dict[str, str] | None = None) -> ExtractedFilters:
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
        category = _detect_category(text, vocab)
        if category:
            f.category = category
        # Сначала исключения («без apple»), потом позитивный бренд по остатку текста,
        # чтобы «не apple» не превратилось в brand=Apple.
        positive_text = low
        for m in _NEG_BRAND_RE.finditer(low):
            word = m.group(1)
            brand = _BRAND_HINTS.get(word)
            if brand and brand not in f.excluded_brands:
                f.excluded_brands.append(brand)
                if f.brand == brand:
                    f.brand = None
            if brand:
                positive_text = positive_text.replace(m.group(0), " ")
        for kw, brand in _BRAND_HINTS.items():
            if kw in positive_text and brand not in f.excluded_brands:
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


_TOKEN_RE = re.compile(r"[a-zа-яё0-9]+", re.IGNORECASE)

# Стоп-слова запроса: не участвуют в релевантности по title
_STOPWORDS = {
    "до", "для", "под", "нужен", "нужна", "нужно", "хочу", "надо", "тыс", "тысяч",
    "руб", "рублей", "какой", "какая", "лучше", "посоветуй", "подбери", "купить",
    "в", "на", "и", "или", "с", "же", "бы", "не", "без",
}

_INT_RE = re.compile(r"\d+")


def _num(value: str | None) -> int | None:
    """«16 ГБ» -> 16; None/мусор -> None."""
    if not value:
        return None
    m = _INT_RE.search(str(value))
    return int(m.group()) if m else None


def _query_tokens(message: str) -> list[str]:
    phrase_tokens, remainder = extract_phrase_tokens(message)
    return phrase_tokens + [
        _alias(t) for t in _TOKEN_RE.findall(remainder)
        if len(t) >= 2 and t not in _STOPWORDS
    ]


def _relevance(p: Product, tokens: list[str]) -> float:
    """Релевантность конкретной модели: exact SKU, совпадение токенов в title,
    попадание в память/накопитель/цвет. «iPhone 16 Pro» должен побеждать
    просто популярный iPhone другой модели."""
    if not tokens:
        return 0.0
    title_tokens = set(_TOKEN_RE.findall((p.title or "").lower()))
    brand_low = (p.brand or "").lower()
    sku_low = (p.sku or "").lower()
    score = 0.0
    hits = 0
    for t in tokens:
        if sku_low and t == sku_low:
            score += 15  # точный артикул — сильнейший сигнал
        if t in title_tokens:
            hits += 1
            score += 7
        elif t == brand_low:
            score += 3
        # совпадение значений характеристик: «512», «16», «синий».
        # Вес высокий (12): явно названная характеристика важнее популярности —
        # иначе популярный «серый 256» обгонит запрошенный «синий 512».
        for attr in (p.memory, p.storage, p.ram, p.color):
            if attr and t == str(attr).lower().split()[0].lower():
                score += 12
                break
    if hits >= 2:
        score += 5  # несколько совпадений в title = вероятно та самая модель
    return score


def _score(p: Product, f: ExtractedFilters, tokens: list[str]) -> float:
    """Мягкий ranking. Жёсткие фильтры уже применены в SQL."""
    score = _relevance(p, tokens)
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
    # сценарии использования: значение RAM важнее факта её наличия —
    # для монтажа/игр 32 ГБ должны ощутимо обгонять 8 ГБ
    if "video_editing" in f.use_cases or "gaming" in f.use_cases:
        ram_gb = _num(p.ram) or _num(p.memory)
        if ram_gb:
            score += min(ram_gb, 32) * 0.4   # 8→3.2, 16→6.4, 32→12.8
        if p.cpu:
            score += 4
        if p.screen_size:
            score += 2
    # качество данных: карточка с характеристиками полезнее для честного ответа
    filled = sum(1 for v in (p.memory, p.storage, p.cpu, p.ram, p.screen_size, p.color) if v)
    score += min(filled, 5)
    if p.image:
        score += 1
    return score


# Сколько токенов запроса участвует в OR-поиске и какой пул он отдаёт на
# ранжирование. Пул щедрый: решает _score в Python, SQL лишь не даёт нужной
# модели выпасть до ранжирования.
_TOKEN_POOL_TOKENS = 8
_TOKEN_POOL_SIZE = 60


def _token_pool(db: Session, tokens: list[str], budget_max: float | None) -> list[Product]:
    """Товары, у которых совпал ХОТЯ БЫ ОДИН значимый токен запроса.

    Ветка нужна потому, что две прежние промахиваются на обычном вопросе вокруг
    названия модели — «Сравни <модель> с альтернативами»:

    - текстовый поиск требует совпадения ВСЕХ первых пяти слов и ломается о
      глагол «Сравни», которого нет ни в одном названии;
    - структурная выборка при известном бренде режет пул по популярности, и у
      бренда с сотней позиций нужная модель до Python-ранжирования не доходит.

    Итог на проде: на вопрос про iPhone 17 Pro Max приходили наушники AirPods
    Max (совпали «Apple», «Max», «Orange»), а сам телефон не попадал в
    кандидаты — и модель честно отвечала «такого в каталоге нет».

    Порядок пула — по ЧИСЛУ совпавших токенов, а не по популярности: обрезать
    список по популярности значит снова потерять точную модель, ради которой
    ветка и заведена.
    """
    words = [t for t in tokens if len(t) >= 3 or t.isdigit()][:_TOKEN_POOL_TOKENS]
    if not words:
        return []

    matches = [Product.title.ilike(f"%{w}%") for w in words]
    matches += [Product.sku.ilike(f"%{w}%") for w in words]
    hits = sum(
        (case((Product.title.ilike(f"%{w}%"), 1), else_=0) for w in words),
        case((Product.sku.ilike(f"%{words[0]}%"), 2), else_=0),  # артикул весомее
    )

    stmt = exclude_preorder(
        exclude_marketplace(select(Product).where(Product.is_active.is_(True), or_(*matches)))
    )
    if budget_max:
        stmt = stmt.where(Product.price <= budget_max)
    stmt = stmt.order_by(
        hits.desc(), Product.in_stock.desc(), Product.popularity.desc(), Product.id
    ).limit(_TOKEN_POOL_SIZE)
    return list(db.execute(stmt).scalars().all())


def alternatives_for(db: Session, product: Product, limit: int = 8) -> list[Product]:
    """Чем можно заменить ЭТОТ товар — выводится из него самого, не из слов.

    Нужно потому, что осмысленный вопрос бывает бессодержательным для поиска:
    «Сравни с альтернативами» — три слова, ни модели, ни категории. Раньше в
    кандидаты попадали просто самые популярные товары бренда, и на вопрос про
    iPhone модель отвечала «других смартфонов нет, остальное — наушники Apple».

    Порядок: сначала то же семейство моделей, потом тот же бренд, затем просто
    категория; внутри — по близости цены. Человек, смотрящий на телефон за
    104 000, сравнивает его с телефонами рядом по цене, а не с самым дешёвым в
    категории и не с самым популярным в магазине.
    """
    if not product.category:
        return []

    # 0 — «свой», 1 — «чужой»; сортировка по возрастанию ставит своих первыми.
    same_family = (
        case((Product.model_family == product.model_family, 0), else_=1)
        if product.model_family else literal(1)
    )
    same_brand = case((Product.brand == product.brand, 0), else_=1) if product.brand else literal(1)
    price_gap = func.abs(Product.price - product.price)

    stmt = (
        exclude_preorder(exclude_marketplace(select(Product)))
        .where(
            Product.is_active.is_(True),
            Product.id != product.id,
            Product.category == product.category,
        )
        .order_by(same_family, same_brand, Product.in_stock.desc(), price_gap, Product.id)
        .limit(limit)
    )
    return list(db.execute(stmt).scalars().all())


def retrieve_candidates(db: Session, message: str, f: ExtractedFilters, limit: int = 12) -> list[Product]:
    """Жёсткие фильтры в SQL -> объединение с текстовым поиском -> мягкий ranking."""
    tokens = _query_tokens(message)
    # 1) текстовый поиск по словам запроса (та же логика, что live-поиск) плюс
    #    пул по отдельным токенам — он ловит модель, когда AND-поиск промахнулся.
    by_words = search_products(db, message, f.budget_max, limit=limit * 2)
    by_tokens = _token_pool(db, tokens, f.budget_max)

    # 2) структурный запрос по извлечённым фильтрам
    stmt = exclude_preorder(exclude_marketplace(select(Product).where(Product.is_active.is_(True))))
    if f.category:
        # Мягкое совпадение вместо жёсткого равенства: категория могла быть
        # извлечена как подкатегория («Фены») или как разговорное слово. Раньше
        # промах давал ноль строк молча — и вся структурная ветка умирала.
        stmt = stmt.where(or_(
            Product.category == f.category,
            Product.subcategory == f.category,
            Product.category.ilike(f"%{f.category}%"),
            Product.subcategory.ilike(f"%{f.category}%"),
        ))
    if f.budget_max:
        stmt = stmt.where(Product.price <= f.budget_max)
    if f.brand:
        stmt = stmt.where(or_(Product.brand.ilike(f"%{f.brand}%"), Product.title.ilike(f"%{f.brand}%")))
    for excluded in f.excluded_brands:
        stmt = stmt.where(~Product.brand.ilike(f"%{excluded}%"))
    if f.condition:
        stmt = stmt.where(Product.condition == f.condition)
    if f.in_stock_only:
        stmt = stmt.where(Product.in_stock.is_(True))
    # Явная детерминированная сортировка ДО limit: иначе при большом каталоге
    # в пул до Python-ranking попадёт случайный срез.
    stmt = stmt.order_by(Product.in_stock.desc(), Product.popularity.desc(), Product.id).limit(limit * 3)
    structural = list(db.execute(stmt).scalars().all())
    # Пустая структурная ветка при извлечённой категории — сигнал, что словарь
    # разъехался с каталогом. Молчать здесь нельзя: именно так баг с «феном»
    # прожил до прода. Текстовая ветка при этом продолжает работать.
    if f.category and not structural:
        logger.warning("Структурная выдача пуста: категория %r не дала товаров (запрос: %r)",
                       f.category, message[:120])

    # 3) объединяем без дублей; исключённые бренды фильтруем и в текстовой ветке
    excluded_low = {b.lower() for b in f.excluded_brands}
    seen: set[int] = set()
    merged: list[Product] = []
    for p in [*by_words, *by_tokens, *structural]:
        if p.id in seen:
            continue
        if excluded_low and (p.brand or "").lower() in excluded_low:
            continue
        seen.add(p.id)
        merged.append(p)

    # 4) ничего не нашли — показываем соседей по категории вместо пустоты.
    # Пустой список промпт трактует как «в каталоге ничего нет», и на запрос
    # «смартфон Samsung» человек слышал «каталога нет» при полной витрине
    # айфонов. Снимаем ТОЛЬКО бренд: он и есть причина промаха, а категория
    # держит замену в том же классе техники. Отвергнутые бренды сюда не
    # возвращаются — это был бы прямой спор с просьбой человека.
    if not merged and f.category and (f.brand or f.excluded_brands):
        alt = exclude_preorder(
            exclude_marketplace(select(Product).where(Product.is_active.is_(True)))
        ).where(or_(
            Product.category == f.category,
            Product.subcategory == f.category,
            Product.category.ilike(f"%{f.category}%"),
            Product.subcategory.ilike(f"%{f.category}%"),
        ))
        if f.budget_max:
            alt = alt.where(Product.price <= f.budget_max)
        for excluded in f.excluded_brands:
            alt = alt.where(~Product.brand.ilike(f"%{excluded}%"))
        alt = alt.order_by(Product.in_stock.desc(), Product.popularity.desc(), Product.id).limit(limit)
        merged = [p for p in db.execute(alt).scalars().all()
                  if (p.brand or "").lower() not in excluded_low]

    merged.sort(key=lambda p: _score(p, f, tokens), reverse=True)
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
