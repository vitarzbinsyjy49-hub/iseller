"""Навигация по каталогу — выводится из товаров, а не из списка в коде (v5.8).

Раньше набор категорий был захардкожен в трёх местах, и любое расхождение с
базой давало мёртвую плитку: пользователь жмёт «Dyson», а категории `dyson` в
БД нет — пустой экран. Теперь единственный источник правды — сами товары:

- категории, которых нет в каталоге, в навигацию не попадают вовсе;
- категория, появившаяся после импорта или правки в админке, появляется сама;
- иконка и подпись — единственное, что нельзя вывести из данных: для незнакомой
  категории берётся нейтральная иконка, подпись — само название с заглавной.

Модуль чистый (только БД, никакого HTTP) — поэтому его используют и публичный
каталог, и главная, и он покрывается тестами без поднятия приложения.
"""
import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.product import Product

# Виртуальная категория: не хранится у товара, а собирается фильтром on_sale.
SALE_KEY = "__sale__"

# Оформление известных категорий. Это НЕ список категорий — только внешний вид
# для тех, что реально есть в каталоге. Добавлять сюда новую категорию не нужно,
# чтобы она заработала: без записи она просто получит нейтральную иконку.
CATEGORY_ICONS: dict[str, str] = {
    "смартфоны": "📱",
    "ноутбуки": "💻",
    "планшеты": "📲",
    "наушники": "🎧",
    "консоли": "🎮",
    "часы": "⌚",
    "красота": "💇",
    "бытовая техника": "🏠",
    "аксессуары": "🔌",
}
FALLBACK_ICON = "🛍️"
SALE_ICON = "🏷️"
SALE_LABEL = "Скидки"

# Оформление известных брендов. Это НЕ список брендов — только внешний вид для
# тех, что реально есть в каталоге: незнакомый бренд попадает в навигацию и без
# записи здесь, просто с нейтральной иконкой.
BRAND_ICONS: dict[str, str] = {
    "apple": "🍏",
    "dyson": "🌀",
    "sony": "🎮",
}


def category_label(raw: str) -> str:
    """«бытовая техника» -> «Бытовая техника». Регистр остальных букв не трогаем:
    в названиях встречаются бренды и аббревиатуры."""
    raw = (raw or "").strip()
    return raw[:1].upper() + raw[1:] if raw else raw


def category_icon(raw: str) -> str:
    return CATEGORY_ICONS.get((raw or "").strip().lower(), FALLBACK_ICON)


def category_counts(db: Session, brand: str | None = None) -> dict[str, int]:
    """{категория: сколько активных товаров}. Пустые категории не возвращаются —
    их не существует по определению (счётчик берётся из самих товаров).

    ``brand`` сужает разрез до одного бренда: у Dyson это «красота» и «бытовая
    техника», и «смартфонов» в таком ответе нет вовсе. Это не косметика —
    каталог, открытый по бренду, показывал ГЛОБАЛЬНЫЙ ряд категорий, и тап по
    «смартфонам» давал brand=Dyson&category=смартфоны, то есть пустой экран.
    Пересечение, которого не существует, не должно быть достижимо в один тап.
    """
    stmt = (
        select(Product.category, func.count())
        .where(Product.is_active.is_(True),
               Product.category.is_not(None), Product.category != "")
        .group_by(Product.category)
    )
    if brand:
        # Точное равенство — тот же способ сравнения, что у фильтра `?brand=`
        # в /catalog/list. Сравнивай мы иначе (например, без регистра), ряд
        # категорий показывал бы не то, что потом вернёт сам каталог.
        stmt = stmt.where(Product.brand == brand)
    rows = db.execute(stmt).all()
    return {c: n for c, n in rows if n}


def brand_counts(db: Session) -> dict[str, int]:
    """{бренд: сколько активных товаров}. Нужен для плиток по бренду: «Dyson» —
    это бренд (50 товаров в двух категориях), а не категория."""
    rows = db.execute(
        select(Product.brand, func.count())
        .where(Product.is_active.is_(True),
               Product.brand.is_not(None), Product.brand != "")
        .group_by(Product.brand)
    ).all()
    return {b: n for b, n in rows if n}


def sale_count(db: Session, brand: str | None = None) -> int:
    stmt = (
        select(func.count()).select_from(Product)
        .where(Product.is_active.is_(True), Product.on_sale.is_(True))
    )
    if brand:
        stmt = stmt.where(Product.brand == brand)
    return db.execute(stmt).scalar_one()


def list_categories(db: Session, brand: str | None = None) -> list[dict]:
    """Категории для навигации: только непустые, крупные первыми.

    Порядок детерминированный (количество убыв., затем имя) — иначе плитки
    прыгали бы между запросами при равных счётчиках.

    С ``brand`` это категории ВНУТРИ бренда. Счётчики тоже брендовые: «красота
    32» рядом с брендом обязана означать 32 товара этого бренда, иначе цифра
    противоречит списку, который откроется по тапу. Незнакомый бренд даёт
    пустой список — это честный ответ «такого бренда у нас нет», а не повод
    показать весь магазин.
    """
    counts = category_counts(db, brand=brand)
    out = [
        {"key": key, "label": category_label(key), "icon": category_icon(key), "count": n}
        for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    sale = sale_count(db, brand=brand)
    if sale:
        out.append({"key": SALE_KEY, "label": SALE_LABEL, "icon": SALE_ICON, "count": sale})
    return out


def brand_icon(raw: str) -> str:
    return BRAND_ICONS.get((raw or "").strip().lower(), FALLBACK_ICON)


def list_brands(db: Session) -> list[dict]:
    """Бренды для навигации: только непустые, крупные первыми.

    Зеркало list_categories(). Ключ — значение Product.brand как оно лежит в
    БД: фильтр `?brand=` сравнивает точным равенством, поэтому нормализация
    ключа увела бы плитку в пустой каталог. Подпись — тот же ключ: у брендов
    собственный регистр, и category_label() здесь только испортил бы имя.

    Виртуальной записи вроде SALE_KEY у брендов нет — скидка не бренд.
    """
    counts = brand_counts(db)
    return [
        {"key": key, "label": key, "icon": brand_icon(key), "count": n}
        for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


# Разговорные слова -> слово, которое реально встречается в названии категории
# или ПОДкатегории. Это НЕ список категорий: справа стоит то, что ищется в БД,
# и если такого раздела в каталоге нет, синоним просто ни во что не разрешится.
# Добавлять сюда новый раздел не нужно — названия категорий и подкатегорий
# попадают в словарь автоматически.
COLLOQUIAL: dict[str, str] = {
    "ноут": "ноутбуки", "лэптоп": "ноутбуки", "макбук": "macbook", "мбп": "macbook pro",
    "телефон": "смартфоны", "айфон": "iphone", "смартфон": "смартфоны",
    "айпад": "ipad", "таблет": "планшеты",
    "аирподс": "airpods", "эирподс": "airpods", "гарнитур": "наушники",
    "приставк": "консоли", "плейстейшн": "консоли", "ps5": "консоли",
    "пс5": "консоли", "консол": "консоли", "джойстик": "аксессуары playstation",
    "вотч": "apple watch", "смарт-часы": "часы",
    "плойка": "стайлеры", "утюжок": "выпрямители", "выпрямител": "выпрямители",
    "сушилк": "фены", "очистител": "климатическая техника",
    "увлажнител": "климатическая техника", "вентилятор": "климатическая техника",
}

# Слишком короткие ключи ловят чужие слова («мак» внутри «Макс»), поэтому в
# словарь из БД попадают только слова от 4 букв. Разговорные — доверенные,
# они выверены руками.
_MIN_DERIVED_LEN = 4
# Слово запроса короче трёх букв по началу не сравниваем — «не», «до», «на»
# поймали бы что угодно. Три буквы нужны: «фен» должен находить раздел «Фены».
_MIN_MATCH_LEN = 3


def category_vocabulary(db: Session) -> dict[str, str]:
    """{слово: категория} — из названий категорий и подкатегорий каталога.

    Именно поэтому «фен» находит раздел: в БД есть подкатегория «Фены» внутри
    категории «красота». Раньше здесь был захардкоженный словарь, который мапил
    «фен» в несуществующую категорию `dyson` — и AI отвечал «нет в наличии» про
    товар, который лежит на витрине.
    """
    # Слово может встретиться в нескольких разделах — копим множества и в конце
    # оставляем только однозначные. Так «pro» из «iPad Pro» и «MacBook Pro»
    # выпадет само, без списка исключений.
    seen: dict[str, set[str]] = {}

    def add(word: str, category: str) -> None:
        word = (word or "").strip().lower()
        if len(word) >= _MIN_DERIVED_LEN:
            seen.setdefault(word, set()).add(category)

    for category in category_counts(db):
        add(category, category)
        for part in category.split():          # «бытовая техника» -> «техника»
            add(part, category)

    rows = db.execute(
        select(Product.subcategory, Product.category)
        .where(Product.is_active.is_(True),
               Product.subcategory.is_not(None), Product.subcategory != "",
               Product.category.is_not(None), Product.category != "")
        .distinct()
    ).all()
    for sub, category in rows:
        add(sub, category)
        for part in sub.split():               # «MacBook Air» -> «macbook», «air»
            add(part, category)

    # Названия брендов из словаря выбрасываем: бренд живёт в нескольких
    # категориях сразу («Apple Watch» дал бы «apple» -> часы, и любой запрос со
    # словом apple уезжал бы в часы). Бренды фильтруются отдельной веткой.
    brands = {b.lower() for b in brand_counts(db)}
    vocab = {w: next(iter(cats)) for w, cats in seen.items()
             if len(cats) == 1 and w not in brands}

    # Разговорный слой поверх: раскрываем через уже собранный словарь, чтобы
    # синоним, указывающий на несуществующий раздел, молча выпал.
    for word, points_to in COLLOQUIAL.items():
        category = _lookup(points_to.lower(), vocab)
        if category:
            vocab.setdefault(word, category)
    return vocab


def _lookup(token: str, vocab: dict[str, str]) -> str | None:
    """Совпадение слова со словарём с учётом числа и падежа.

    Сравниваем по началу в обе стороны: запрос «пылесос» должен найти раздел
    «Пылесосы», а запрос «планшеты» — категорию «планшеты». Точное совпадение
    вперёд, затем более длинные ключи — «apple watch» важнее «watch»."""
    if token in vocab:
        return vocab[token]
    if len(token) < _MIN_MATCH_LEN:
        return None
    for word in sorted(vocab, key=len, reverse=True):
        # Составные ключи («apple watch») сравниваем только точно: иначе токен
        # «apple» из «не apple, нужен фен» уводил весь запрос в часы.
        if " " in word:
            continue
        if word.startswith(token) or token.startswith(word):
            return vocab[word]
    return None


_TOKEN_RE = re.compile(r"[a-zа-яё0-9]+", re.IGNORECASE)


def resolve_category(text: str, vocab: dict[str, str]) -> str | None:
    """Категория, упомянутая в тексте. Чистая функция — словарь готовит caller.

    Идём по словам запроса, длинные слова первыми: в «не apple, нужен фен»
    решает «фен», а не случайное короткое совпадение."""
    tokens = sorted(set(_TOKEN_RE.findall((text or "").lower())), key=len, reverse=True)
    for token in tokens:
        category = _lookup(token, vocab)
        if category:
            return category
    return None


def target_count(
    action_type: str, action_value: str | None, *,
    categories: dict[str, int], brands: dict[str, int], sale: int,
) -> int | None:
    """Сколько товаров стоит за плиткой главной.

    None — «посчитать нельзя» (поиск, подборка, AI, внешняя ссылка): такие
    плитки не скрываем, потому что отсутствие ответа не означает пустоту.

    Чистая функция: счётчики считает вызывающий, один раз на запрос — иначе
    получили бы N запросов к БД на N плиток."""
    value = (action_value or "").strip()
    if action_type == "category":
        if value == SALE_KEY:
            return sale
        return categories.get(value, 0) if value else 0
    if action_type == "brand":
        return brands.get(value, 0) if value else 0
    return None


def has_products(
    action_type: str, action_value: str | None, *,
    categories: dict[str, int], brands: dict[str, int], sale: int,
) -> bool:
    """Показывать ли плитку. Непосчитаемые считаем видимыми."""
    n = target_count(action_type, action_value,
                     categories=categories, brands=brands, sale=sale)
    return n is None or n > 0
