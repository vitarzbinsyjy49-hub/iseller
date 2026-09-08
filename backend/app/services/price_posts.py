"""Генерация постоянных прайс-постов канала (v5.6.0) — чистая логика без сети.

Модель работы, ради которой всё и затевалось: прайс-пост публикуется в канал
ОДИН раз, а дальше редактируется на том же message_id. Поэтому у каждого
раздела есть стабильный slug: он переживает перегенерацию и связывает
«раздел каталога» с «конкретным сообщением в Telegram». Никакая перестановка
товаров, смена цен или деление длинного поста на части не должны менять slug —
иначе система потеряет сообщение и опубликует дубль.

Здесь нет ни одного обращения к Telegram и к БД: на вход — список товаров
(обычные словари), на выход — готовые тексты и клавиатуры. Так всё поведение
(группировка, форматирование, лимит 4096, escaping, diff) проверяется тестами.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date
from html import escape

# Telegram режет сообщение на 4096 символах. Держим запас на служебные строки
# («Часть 2 из 2», дата) и на неточности подсчёта entity — лучше лишний раз
# разделить пост, чем получить отказ на публикации.
TELEGRAM_TEXT_LIMIT = 4096
SAFE_TEXT_LIMIT = 3900


@dataclass(frozen=True)
class Section:
    """Раздел прайса: стабильный slug + правило отбора товаров."""
    slug: str
    emoji: str
    title: str
    #: (category, subcategory) — subcategory None означает «любая в категории».
    match: tuple[tuple[str | None, str | None], ...]
    brand: str | None = None
    #: Подзаголовки внутри поста, в этом порядке; остальное уходит в конец.
    subgroups: tuple[str, ...] = ()
    #: Маршрут Mini App для кнопки «Открыть раздел».
    route: str = "/catalog"


#: Порядок разделов = порядок кнопок в навигационном посте.
SECTIONS: tuple[Section, ...] = (
    Section("price_iphone", "📱", "iPhone", ((("смартфоны", "iPhone"),)),
            route="/catalog?category=смартфоны&subcategory=iPhone"),
    Section("price_airpods", "🎧", "AirPods", ((("наушники", "AirPods"),)),
            route="/catalog?category=наушники&subcategory=AirPods"),
    Section("price_macbook_air", "💻", "MacBook Air", ((("ноутбуки", "MacBook Air"),)),
            route="/catalog?category=ноутбуки&subcategory=MacBook%20Air"),
    Section("price_macbook_pro", "💻", "MacBook Pro", ((("ноутбуки", "MacBook Pro"),)),
            route="/catalog?category=ноутбуки&subcategory=MacBook%20Pro"),
    Section("price_ipad", "📱", "iPad", ((("планшеты", None),)),
            route="/catalog?category=планшеты"),
    Section("price_watch", "⌚", "Apple Watch", ((("часы", None),)),
            route="/catalog?category=часы"),
    Section("price_homepod", "🔊", "HomePod", ((("аудио", None),)),
            route="/catalog?category=аудио"),
    # Аксессуары — один раздел на клавиатуры, ремешки и зарядки: по отдельности
    # это посты на две-три строки, а вместе — осмысленная страница прайса.
    Section("price_accessories", "🔌", "Аксессуары", ((("аксессуары", None),)),
            subgroups=("Magic Keyboard", "Ремешки Apple Watch", "Зарядные устройства"),
            route="/catalog?category=аксессуары"),
    Section("price_playstation", "🎮", "PlayStation", ((("консоли", None),)),
            subgroups=("Консоли", "Аксессуары PlayStation"),
            route="/catalog?category=консоли"),
    # Dyson — ОДИН раздел и одна кнопка в навигации. Раньше их было три
    # (волосы / пылесосы / климат), и меню из-за этого выглядело
    # несбалансированным: три кнопки одного бренда против одной у Apple по
    # каждой линейке. Подгруппы никуда не делись — они стали подзаголовками
    # внутри поста, и весь Dyson помещается в один пост с запасом.
    Section("price_dyson", "💨", "Dyson",
            (("красота", None), ("бытовая техника", None)),
            brand="Dyson",
            subgroups=("Стайлеры", "Фены", "Выпрямители", "Пылесосы",
                       "Климатическая техника"),
            route="/catalog?brand=Dyson"),
    # Karcher и Jura лежат в той же категории «бытовая техника», что и Dyson, и
    # разводятся ТОЛЬКО брендом — как и сам Dyson. Без brand= раздел собрал бы
    # чужие товары: правило отбора здесь не «категория», а «категория И бренд».
    Section("price_karcher", "🧼", "Karcher", ((("бытовая техника", "Уборка"),)),
            brand="Karcher",
            route="/catalog?brand=Karcher"),
    Section("price_jura", "☕", "Jura", ((("бытовая техника", "Кофемашины"),)),
            brand="Jura",
            route="/catalog?brand=Jura"),
)

SECTIONS_BY_SLUG = {s.slug: s for s in SECTIONS}

NAVIGATION_SLUG = "price_navigation"

#: Валюта названа ЗДЕСЬ, один раз на пост, а не в каждой строке прайса: знак
#: рубля в полусотне строк подряд ничего не уточняет, но удлиняет каждую из них
#: (см. format_price).
DISCLAIMER = (
    "Цены AI Seller, в рублях.\n"
    "Наличие, регион и комплектацию подтверждает менеджер."
)


# ---------------------------------------------------------------- форматирование

def format_price(value: float | int) -> str:
    """«89.500» — разряды отбиваются точкой, копейки не показываем.

    Формат взят с прайсов этого рынка (референс — канал BSA), и причина не в
    подражании: точка не переносится. Пробел внутри числа Telegram считает
    местом возможного переноса строки, и на узком экране «89 500 ₽»
    разрывается пополам — половина цены уезжает на следующую строку. Точка
    держит число целым, а строка становится короче на два символа, что на
    списке в полсотни позиций заметно экономит высоту поста.

    Знака рубля в строке нет намеренно: он повторялся бы в каждой строке
    прайса, где валюта и так одна. Она названа один раз, в шапке раздела.
    """
    return f"{int(round(float(value))):,}".replace(",", ".")


#: Коды стран поставки, которые встречаются в названиях товаров. Регион важен
#: покупателю (гарантия, комплект, замок SIM), но кодом «HK-KR» он читается
#: плохо — во всех прайсах этого рынка вместо кода ставят флаг.
REGION_FLAGS: dict[str, str] = {
    "US": "🇺🇸", "HK": "🇭🇰", "IN": "🇮🇳", "JP": "🇯🇵", "KR": "🇰🇷",
    "EU": "🇪🇺", "GB": "🇬🇧", "KW": "🇰🇼", "CN": "🇨🇳", "SG": "🇸🇬",
    "RU": "🇷🇺", "AE": "🇦🇪", "TR": "🇹🇷", "VN": "🇻🇳", "UA": "🇺🇦",
}

_PARENS_RE = re.compile(r"\s*\(([^)]*)\)")


def _codes_for(token: str) -> list[str] | None:
    """Коды для «HK» или «HK-KR», иначе None (значит это не регион)."""
    parts = [p.strip().upper() for p in token.split("-") if p.strip()]
    if not parts or not all(p in REGION_FLAGS for p in parts):
        return None
    return parts


def split_region_codes(title: str) -> tuple[list[str], str]:
    """Вынести регион из названия как СПИСОК КОДОВ (не готовую строку эмодзи).

    Общая основа для split_region (эмодзи для постов канала — там свой шрифт
    Telegram, эмодзи-флаги рисуются надёжно) и для витрины, где вместо эмодзи
    нужны SVG-иконки: Windows штатно НЕ собирает пару «региональных индикаторов»
    в картинку флага и показывает их как есть, буквами («🇮🇳🇺🇸🇭🇰» превращается в
    нечитаемое «INUSHK»). Список кодов вместо строки даёт фронту материал для
    любого рендера — эмодзи, SVG, текст с разделителями.

    В скобках у товара может лежать и регион, и важное уточнение
    (SIM+eSIM, Case, конфигурация памяти). Кодом заменяем ТОЛЬКО то, что
    целиком является кодом страны; всё остальное остаётся в названии как было —
    потерять «SIM+eSIM» или «16GB/512GB» значит слить разные позиции в одну.
    """
    codes: list[str] = []

    def replace(match: re.Match) -> str:
        kept: list[str] = []
        for part in match.group(1).split(","):
            token = part.strip()
            if not token:
                continue
            found = _codes_for(token)
            if found:
                codes.extend(found)
            else:
                kept.append(token)
        return f" ({', '.join(kept)})" if kept else ""

    cleaned = _PARENS_RE.sub(replace, title).strip()
    return codes, cleaned


def split_region(title: str) -> tuple[str, str]:
    """Вынести флаги страны из названия: («🇭🇰🇰🇷», «iPhone 17 Pro (SIM+eSIM)»).

    Обёртка над split_region_codes для постов канала — там эмодзи-флаги
    рендерятся надёжно (свой шрифт Telegram-клиента). На витрине этой строкой
    больше не пользуемся, см. split_region_codes.
    """
    codes, cleaned = split_region_codes(title)
    return "".join(REGION_FLAGS[c] for c in codes), cleaned


_MEMORY_RE = re.compile(r"^\d+\s*(ГБ|ТБ|GB|TB)$", re.IGNORECASE)


def model_key(title: str) -> str:
    """Ключ модели для визуальной группировки строк внутри подгруппы.

    Берём название до первого указания памяти: «iPhone 17 Pro 256 ГБ Blue» ->
    «iPhone 17 Pro». Сплошной список из 46 айфонов читать тяжело, а пустая
    строка между моделями превращает его в короткие блоки — так устроены все
    прайс-каналы этого рынка.
    """
    tokens = title.split()
    head: list[str] = []
    for index, token in enumerate(tokens):
        pair = f"{token} {tokens[index + 1]}" if index + 1 < len(tokens) else token
        if _MEMORY_RE.match(pair) or _MEMORY_RE.match(token) or re.match(r"^\d+/\d+", token):
            break
        head.append(token)
        if len(head) >= 4:
            break
    return " ".join(head) if head else title


def shorten_title(title: str, brand: str | None, section: Section) -> str:
    """Убрать из названия то, что уже сказано разделом.

    Срезаем ТОЛЬКО ведущее имя бренда и дублирующее имя раздела: «Apple iPhone
    17 Pro 256 Blue» в разделе iPhone читается как «iPhone 17 Pro 256 Blue».
    Всё, что отличает товары друг от друга — память, размер, цвет, регион, SIM,
    комплектация — не трогаем никогда: именно по этим словам покупатель и
    выбирает, и потерять их значит слить разные позиции в одинаковые строки.
    """
    result = title.strip()
    if brand and result.lower().startswith(brand.lower() + " "):
        result = result[len(brand) + 1:]
    return result.strip()


def product_line(product: dict, section: Section) -> str:
    """Одна строка прайса: «🇭🇰 iPhone 17 Pro 256 ГБ Blue — 96 000 ₽».

    Флаг заменяет маркер списка: он и так стоит в начале строки, и две метки
    подряд («• 🇭🇰 …») только зашумляют. У товара без региона маркер остаётся.
    """
    flags, cleaned = split_region(product["title"])
    name = escape(shorten_title(cleaned, product.get("brand"), section))
    price = escape(format_price(product["price"]))
    line = f"{flags} {name} — {price}" if flags else f"• {name} — {price}"
    old = product.get("old_price")
    # Старую цену показываем ТОЛЬКО когда она реально выше текущей: иначе это
    # выдуманная скидка, а её в прайсе быть не должно.
    if old and float(old) > float(product["price"]):
        line += f" <s>{escape(format_price(old))}</s>"
    return line


def sort_key(product: dict) -> tuple:
    """Сначала модель, внутри модели — по цене, затем по названию.

    Модель первым ключом нужна, чтобы позиции одной модели шли подряд: строки
    группируются пустой строкой по этому же признаку, и при сортировке только
    по цене блоки распались бы на одиночные строки с пустотами между ними.

    Порядок обязан быть детерминированным: пост сравнивается сам с собой между
    прогонами, и «шевеление» строк от случайного порядка выдало бы ложный diff
    и лишнее редактирование боевого сообщения.
    """
    _flags, cleaned = split_region(product["title"])
    brand = product.get("brand")
    if brand and cleaned.lower().startswith(brand.lower() + " "):
        cleaned = cleaned[len(brand) + 1:]
    return (model_key(cleaned), float(product["price"]), product["title"])


# ---------------------------------------------------------------- отбор товаров

def matches(product: dict, section: Section) -> bool:
    if section.brand and (product.get("brand") or "") != section.brand:
        return False
    category = product.get("category")
    subcategory = product.get("subcategory")
    for want_cat, want_sub in section.match:
        if category != want_cat:
            continue
        if want_sub is None or subcategory == want_sub:
            return True
    return False


def select_products(products: list[dict], section: Section) -> list[dict]:
    """Активные товары раздела. Выключенные в админке в прайс не попадают."""
    return [p for p in products if p.get("is_active", True) and matches(p, section)]


def group_by_subgroup(products: list[dict], section: Section) -> list[tuple[str | None, list[dict]]]:
    """Разбить на подгруппы в заданном разделом порядке.

    Подгруппы, которых нет в списке section.subgroups, идут в конце по алфавиту —
    новая подкатегория в каталоге не должна потеряться из поста молча.
    """
    buckets: dict[str | None, list[dict]] = {}
    for product in products:
        buckets.setdefault(product.get("subcategory"), []).append(product)

    ordered: list[tuple[str | None, list[dict]]] = []
    for name in section.subgroups:
        if name in buckets:
            ordered.append((name, sorted(buckets.pop(name), key=sort_key)))
    for name in sorted(buckets, key=lambda x: (x is None, x or "")):
        ordered.append((name, sorted(buckets[name], key=sort_key)))

    # Раздел без объявленных подгрупп и с единственной подкатегорией не должен
    # получать бессмысленный подзаголовок, повторяющий заголовок поста.
    if not section.subgroups and len(ordered) == 1:
        return [(None, ordered[0][1])]
    return ordered


# ---------------------------------------------------------------- сборка постов

@dataclass
class RenderedPost:
    """Готовый пост: slug привязывает его к сообщению в Telegram навсегда."""
    slug: str
    section_slug: str
    title: str
    text: str
    item_count: int
    part: int = 1
    parts_total: int = 1
    keyboard: list[list[dict]] = field(default_factory=list)


#: С какого размера списка пустые строки между моделями начинают помогать.
#: Семьдесят айфонов подряд глазом не разбираются; три позиции Karcher —
#: разбираются, и та же разбивка растаскивала их пустотами вдвое.
MODEL_BREAK_MIN_ITEMS = 10

#: Сколько строк в среднем должно приходиться на модель, чтобы деление имело
#: смысл. У Dyson почти каждый стайлер — отдельная модель (HS05, HS08, HS09,
#: Airwrap), и разделитель вставал МЕЖДУ КАЖДОЙ строкой: пустая строка обязана
#: отделять блоки, а если блоков нет, она отделяет строку от строки и просто
#: раздувает пост вдвое.
MODEL_BREAK_MIN_BLOCK = 1.5


def _lines_with_model_breaks(items: list[dict], section: Section) -> list[str]:
    """Строки товаров; пустая строка между моделями — только когда она делит
    именно БЛОКИ, а не отдельные строки.

    Разбивка по модели («iPhone 17», «iPhone 17 Pro», «iPhone Air») превращает
    длинный список в короткие блоки, которые видно с одного взгляда. Пустая
    строка — единственный разделитель: подзаголовок на каждую модель раздул бы
    пост вдвое. Включается она при двух условиях сразу — список достаточно
    длинный (MODEL_BREAK_MIN_ITEMS) И модели действительно собирают под себя
    больше одной позиции (MODEL_BREAK_MIN_BLOCK).
    """
    keys = [
        model_key(shorten_title(split_region(item["title"])[1],
                                item.get("brand"), section))
        for item in items
    ]
    distinct = len(set(keys))
    split_models = (
        len(items) >= MODEL_BREAK_MIN_ITEMS
        and distinct > 0
        and len(items) / distinct >= MODEL_BREAK_MIN_BLOCK
    )

    lines: list[str] = []
    previous: str | None = None
    for item, key in zip(items, keys):
        if split_models and previous is not None and key != previous:
            lines.append("")
        lines.append(product_line(item, section))
        previous = key
    return lines


def _header(section: Section, on_date: date) -> str:
    return (
        f"{section.emoji} <b>{escape(section.title.upper())} — АКТУАЛЬНЫЙ ПРАЙС</b>\n"
        f"\n{DISCLAIMER}\n\n"
    )


def _footer(on_date: date) -> str:
    return f"\n\nАктуально на: {on_date.strftime('%d.%m.%Y')}"


def render_section(
    products: list[dict], section: Section, on_date: date, mini_app_url: str,
    manager_url: str = "", bot_username: str = "", app_short_name: str = "",
) -> list[RenderedPost]:
    """Собрать пост(ы) раздела. Длинный раздел делится по границам подгрупп.

    Деление идёт ТОЛЬКО между подгруппами и никогда не режет товарную строку.
    Если одна подгруппа сама по себе не влезает — делим её по товарам, но
    строку по-прежнему оставляем целой: обрезанное название с половиной цены
    хуже, чем лишнее сообщение.
    """
    selected = select_products(products, section)
    if not selected:
        return []

    header = _header(section, on_date)
    footer = _footer(on_date)
    groups = group_by_subgroup(selected, section)

    # Собираем «блоки» — подзаголовок со своими строками; блок неделим по
    # умолчанию и режется только если сам по себе превышает лимит.
    blocks: list[list[str]] = []
    for name, items in groups:
        lines = _lines_with_model_breaks(items, section)
        block: list[str] = ([f"\n<b>{escape(name)}</b>\n"] if name else [])
        for line in lines:
            candidate = block + [line]
            if len("\n".join(candidate)) > SAFE_TEXT_LIMIT - len(header) - len(footer):
                blocks.append(block)
                block = ([f"\n<b>{escape(name)} (продолжение)</b>\n"] if name else []) + [line]
            else:
                block = candidate
        if block:
            blocks.append(block)

    # Складываем блоки в посты, пока помещаются.
    pages: list[list[str]] = []
    current: list[str] = []
    for block in blocks:
        candidate = current + block
        body = "\n".join(candidate)
        if current and len(header) + len(body) + len(footer) + 40 > SAFE_TEXT_LIMIT:
            pages.append(current)
            current = block
        else:
            current = candidate
    if current:
        pages.append(current)

    # Хвостовая страница из одной-двух строк («Часть 3 из 3» с единственным
    # товаром) — не решение, а побочный эффект упаковки: последний блок не
    # поместился в SAFE_TEXT_LIMIT предыдущей страницы буквально впритык и
    # уехал в новое сообщение целиком. У последней страницы расти уже
    # некуда, поэтому для НЕЁ одной проверяем настоящий лимит Telegram, а не
    # запасливый SAFE_TEXT_LIMIT (тот держит запас на случай, если следом
    # добавится ещё контент, — здесь этого случая по определению не будет).
    #
    # Поправка +25, а не общая +40: та грубо прикидывает «Часть N из M», ещё
    # не зная итоговый total. «Часть 9 из 9» с тегами — 21 символ, 25 берёт
    # с запасом, не съедая лишние ~15 символов мимо реальной длины строки.
    while len(pages) > 1:
        merged = pages[-2] + pages[-1]
        body = "\n".join(merged)
        if len(header) + len(body) + len(footer) + 25 > TELEGRAM_TEXT_LIMIT - 140:
            break
        pages[-2] = merged
        pages.pop()

    total = len(pages)
    posts: list[RenderedPost] = []
    for index, page in enumerate(pages, start=1):
        # slug части: базовый slug у первой части, чтобы уже опубликованный
        # раздел не «переехал» на новый идентификатор, когда пост впервые
        # перерос лимит и разделился надвое.
        slug = section.slug if index == 1 else f"{section.slug}_p{index}"
        part_note = f"\n<i>Часть {index} из {total}</i>\n" if total > 1 else ""
        text = header + part_note + "\n".join(page) + footer
        posts.append(RenderedPost(
            slug=slug,
            section_slug=section.slug,
            title=f"{section.title}" + (f" (часть {index})" if total > 1 else ""),
            text=text,
            item_count=sum(1 for line in page if _IS_PRODUCT_LINE.match(line)),
            part=index,
            parts_total=total,
            keyboard=section_keyboard(section, mini_app_url, manager_url, bot_username, app_short_name),
        ))
    return posts


def render_all(
    products: list[dict], on_date: date, mini_app_url: str, manager_url: str = "",
    bot_username: str = "", app_short_name: str = "",
) -> list[RenderedPost]:
    posts: list[RenderedPost] = []
    for section in SECTIONS:
        posts.extend(render_section(
            products, section, on_date, mini_app_url, manager_url, bot_username, app_short_name))
    return posts


# ---------------------------------------------------------------- клавиатуры

def deep_link(bot_username: str, payload: str, app_short_name: str = "") -> str | None:
    """Ссылка на канальную кнопку, открывающая нужный экран Mini App.

    Почему вообще ссылка, а не web_app-кнопка. Telegram разрешает кнопки типа
    web_app ТОЛЬКО в личных чатах с ботом; в канале такое сообщение отвергается
    целиком с BUTTON_TYPE_INVALID — не «кнопка не показалась», а пост не
    публикуется вовсе. Поэтому в канале кнопки обычные, url.

    Два формата такой ссылки:
    - без `app_short_name` (по умолчанию) — t.me/<bot>?start=<payload>. Всегда
      СНАЧАЛА открывает личный чат с ботом, бот отвечает сообщением с
      web_app-кнопкой, и только по ней открывается Mini App — два тапа;
    - с `app_short_name` (короткое имя Mini App, выдаёт BotFather через
      /newapp — НЕ то же самое, что имя бота) — t.me/<bot>/<app>?startapp=
      <payload>. Открывает Mini App НАПРЯМУЮ, чат с ботом не появляется вовсе,
      один тап. Тот же payload, тот же обработчик на фронте (см. resolve_payload_path).
    """
    bot = (bot_username or "").strip().lstrip("@")
    if not bot:
        return None
    app = (app_short_name or "").strip()
    if app:
        return f"https://t.me/{bot}/{app}?startapp={payload}"
    return f"https://t.me/{bot}?start={payload}"


def _web_app_button(text: str, mini_app_url: str, route: str) -> dict | None:
    """web_app-кнопка — только для ЛИЧНОГО чата с ботом (в канал не годится)."""
    base = (mini_app_url or "").strip().rstrip("/")
    if not base.startswith("https://"):
        return None
    return {"text": text, "web_app": {"url": f"{base}{route}"}}


def _deep_link_button(text: str, bot_username: str, payload: str, app_short_name: str = "") -> dict | None:
    url = deep_link(bot_username, payload, app_short_name)
    return {"text": text, "url": url} if url else None


def _url_button(text: str, url: str) -> dict | None:
    u = (url or "").strip()
    return {"text": text, "url": u} if u.startswith("https://") else None


def _rows(*rows: list[dict]) -> list[list[dict]]:
    return [[b for b in row if b] for row in rows if any(row)]


def section_keyboard(
    section: Section, mini_app_url: str, manager_url: str = "", bot_username: str = "",
    app_short_name: str = "",
) -> list[list[dict]]:
    """Клавиатура прайс-поста в КАНАЛЕ — только url-кнопки (см. deep_link)."""
    return _rows(
        [_deep_link_button("🛍 Открыть раздел", bot_username, section.slug, app_short_name)],
        [
            _deep_link_button("✨ Подобрать с AI", bot_username, "ai", app_short_name),
            _url_button("💬 Менеджер", manager_url),
        ],
    )


def message_link(channel_id: int | str, message_id: int) -> str:
    """Ссылка на сообщение канала для кнопки навигации.

    Приватные каналы адресуются как t.me/c/<id без -100>/<message_id>;
    у публичного канала с @username работает t.me/<username>/<message_id>.
    """
    raw = str(channel_id)
    if raw.startswith("@"):
        return f"https://t.me/{raw[1:]}/{message_id}"
    internal = raw[4:] if raw.startswith("-100") else raw.lstrip("-")
    return f"https://t.me/c/{internal}/{message_id}"


def navigation_text(on_date: date) -> str:
    """Текст закреплённого поста-навигатора.

    Это первое, что читает человек, впервые попавший в группу, — поэтому кроме
    ссылок здесь короткое «что это за магазин и на каких условиях». Раньше пост
    состоял из заголовка и строки «выберите раздел»: навигация по прайсу для
    того, кто уже понял, куда пришёл.

    Условия названы ровно те, что магазин выполняет, и теми же словами, что в
    приложении и в инфо-постах. Сроков доставки и тарифов здесь нет намеренно:
    их определяет менеджер, и цифра в закрепе стала бы обязательством.
    """
    return (
        "🛍 <b>АЙСЕЛЛЕР</b>\n"
        "Техника Apple, Dyson и PlayStation с Горбушки\n"
        "\n"
        "Прайс ниже обновляется на месте — сообщения не публикуются заново, "
        f"поэтому цены здесь всегда актуальные. На {on_date.strftime('%d.%m.%Y')}.\n"
        "\n"
        "• <b>Самовывоз</b> — Горбушка, Москва, ежедневно 10:00–21:00\n"
        "• <b>Доставка</b> — курьером по Москве, СДЭК по России\n"
        "• <b>Оплата</b> — наличными при получении\n"
        "• <b>Гарантия 1 месяц</b>, технику проверяем вместе до оплаты\n"
        "\n"
        "В приложении — каталог с фото и характеристиками и AI-подбор: "
        "опишите задачу и бюджет, он предложит варианты из наличия.\n"
        "\n"
        "Выберите раздел:"
    )


def navigation_keyboard(
    published: dict[str, int], channel_id: int | str, mini_app_url: str,
    manager_url: str = "", bot_username: str = "",
    info: tuple[tuple[str, str, str], ...] = (), app_short_name: str = "",
) -> list[list[dict]]:
    """Кнопки навигации ведут на КОНКРЕТНЫЕ опубликованные посты.

    Раздел без message_id пропускаем: кнопка, ведущая в никуда, хуже её
    отсутствия. Поэтому навигацию всегда обновляют ПОСЛЕ публикации разделов.
    """
    rows: list[list[dict]] = []
    for section in SECTIONS:
        message_id = published.get(section.slug)
        if not message_id:
            continue
        rows.append([{
            "text": f"{section.emoji} {section.title}",
            "url": message_link(channel_id, message_id),
        }])
    # Инфо-разделы (гарантия, доставка, оплата) идут ПОСЛЕ прайса: человек
    # приходит в канал за ценой, а условия читает вторым шагом.
    for slug, label, _title in info:
        message_id = published.get(slug)
        if message_id:
            rows.append([{"text": label, "url": message_link(channel_id, message_id)}])

    tail = _rows(
        [_deep_link_button("🛍 Весь каталог", bot_username, "catalog", app_short_name)],
        [
            _deep_link_button("✨ Подобрать с AI", bot_username, "ai", app_short_name),
            _url_button("💬 Менеджер", manager_url),
        ],
    )
    return rows + tail


# ---------------------------------------------------------------- diff и хэш

def catalog_fingerprint(products: list[dict]) -> str:
    """Отпечаток каталога: меняется ровно тогда, когда меняется прайс.

    В него входит только то, что видно в посте (sku, название, цена, старая
    цена, активность). Правки описания или фото пост не меняют и не должны
    провоцировать перепубликацию.
    """
    parts = sorted(
        f"{p.get('sku') or p.get('id')}|{p['title']}|{p['price']}|{p.get('old_price') or ''}|{int(bool(p.get('is_active', True)))}"
        for p in products
    )
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


@dataclass
class PriceDiff:
    """Что изменится в разделе, если его обновить."""
    slug: str
    price_changes: list[tuple[str, float, float]] = field(default_factory=list)
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    text_changed: bool = False
    over_limit: bool = False

    @property
    def has_changes(self) -> bool:
        return bool(self.price_changes or self.added or self.removed or self.text_changed)


#: Цена в строке. Разбирать надо ОБА формата, и это не переходная мера.
#:
#: Сейчас цена печатается как «89.500» (см. format_price), но в канале лежат
#: посты, опубликованные в прежней вёрстке — «89 500 ₽». diff сравнивает
#: генерацию с тем, что РЕАЛЬНО в канале, а не с нашим кэшем; понимай парсер
#: только новый формат, каждая старая строка читалась бы как «позиция удалена,
#: добавлена другая», и администратор увидел бы полную пересборку там, где не
#: изменилось ничего.
# Число берём ЖАДНО и обязательно заканчиваем цифрой: «96 000 ₽» иначе
# обрывается на первом пробеле и читается как 96. Хвост «₽» необязателен —
# в новом формате его нет. Скобка `<s>` со старой ценой не захватывается:
# «<» в класс не входит, и жадность отступает до последней цифры.
_PRICE_RE = r"(?P<price>\d(?:[\d.  ]*\d)?)(?:\s*₽)?"

#: Товарная строка: начинается с маркера или флага, заканчивается ценой.
_IS_PRODUCT_LINE = re.compile(r"^(?:•|[🇦-🇿]{2,}) .+ — \d")

_LINE_RE = re.compile(
    r"^(?:•|[🇦-🇿]{2,})\s+(?P<name>.+?) — " + _PRICE_RE + r"(?=\s|<|$)",
    re.MULTILINE)


def parse_lines(text: str) -> dict[str, float]:
    """Разобрать опубликованный текст обратно в {название: цена}.

    Нужно, чтобы показать администратору настоящий diff против того, что
    ЛЕЖИТ В КАНАЛЕ, а не против нашей прошлой генерации: между прогонами пост
    могли поправить руками, и сравнение с собственным кэшем это скрыло бы.
    """
    result: dict[str, float] = {}
    for match in _LINE_RE.finditer(text):
        # Точка — разделитель разрядов, а не дробная часть: копейки в прайсе
        # не печатаются вовсе (format_price округляет до рубля).
        price = re.sub(r"[^\d]", "", match.group("price"))
        try:
            result[match.group("name").strip()] = float(price)
        except ValueError:
            continue
    return result


def diff_posts(old_text: str, new: RenderedPost) -> PriceDiff:
    old_lines = parse_lines(old_text or "")
    new_lines = parse_lines(new.text)
    diff = PriceDiff(slug=new.slug)

    for name, price in new_lines.items():
        if name not in old_lines:
            diff.added.append(name)
        elif old_lines[name] != price:
            diff.price_changes.append((name, old_lines[name], price))
    diff.removed = [name for name in old_lines if name not in new_lines]
    diff.text_changed = (old_text or "").strip() != new.text.strip()
    diff.over_limit = len(new.text) > TELEGRAM_TEXT_LIMIT
    return diff
