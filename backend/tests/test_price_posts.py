"""Тесты генератора прайс-постов (v5.6.0).

Главное свойство, которое здесь защищается: пост публикуется один раз и дальше
редактируется на том же message_id. Значит slug раздела обязан быть стабильным,
порядок строк — детерминированным, а «изменилось / не изменилось» — честным.
Любая нестабильность здесь превращается в лишние правки боевых сообщений.
"""
from datetime import date

import pytest

from app.services.price_posts import (
    NAVIGATION_SLUG,
    SAFE_TEXT_LIMIT,
    SECTIONS,
    SECTIONS_BY_SLUG,
    TELEGRAM_TEXT_LIMIT,
    catalog_fingerprint,
    diff_posts,
    format_price,
    group_by_subgroup,
    message_link,
    navigation_keyboard,
    navigation_text,
    parse_lines,
    render_all,
    render_section,
    select_products,
    shorten_title,
)

TODAY = date(2026, 7, 28)
MINI_APP = "https://shop.example.com"
MANAGER = "https://t.me/iseller77"


def product(**kw) -> dict:
    base = dict(
        sku="SKU-1", title="Apple iPhone 17 Pro 256 Blue", brand="Apple",
        category="смартфоны", subcategory="iPhone", price=89500,
        old_price=None, stock=1, is_active=True,
    )
    base.update(kw)
    return base


# ---------------------------------------------------------------- цена

@pytest.mark.parametrize("value,expected", [
    (89500, "89 500 ₽"),
    (9500, "9 500 ₽"),
    (1380000, "1 380 000 ₽"),
    (999, "999 ₽"),
    (89500.4, "89 500 ₽"),
])
def test_format_price(value, expected):
    assert format_price(value) == expected


def test_price_uses_plain_space_so_it_stays_searchable():
    """Неразрывный пробел ломает поиск и копирование цены из канала."""
    assert " " not in format_price(89500)


# ---------------------------------------------------------------- названия

def test_leading_brand_is_trimmed_but_details_are_kept():
    section = SECTIONS_BY_SLUG["price_iphone"]
    assert shorten_title("Apple iPhone 17 Pro 256 Blue", "Apple", section) == "iPhone 17 Pro 256 Blue"


@pytest.mark.parametrize("title", [
    "Apple iPhone 17 Pro 512 Silver eSIM",
    "Apple MacBook Air 13 M5 24GB/1TB Midnight",
    "Dyson Airwrap Complete Long Nickel/Copper",
])
def test_distinguishing_details_survive_shortening(title):
    """Память, размер, цвет, SIM и комплектация отличают позиции друг от друга."""
    section = SECTIONS_BY_SLUG["price_iphone"]
    short = shorten_title(title, "Apple", section)
    for token in title.split()[2:]:
        assert token in short


# ---------------------------------------------------------------- отбор

def test_inactive_products_are_excluded():
    section = SECTIONS_BY_SLUG["price_iphone"]
    products = [product(sku="A"), product(sku="B", is_active=False)]
    assert [p["sku"] for p in select_products(products, section)] == ["A"]


def test_section_matches_only_its_own_products():
    section = SECTIONS_BY_SLUG["price_iphone"]
    products = [product(), product(category="наушники", subcategory="AirPods")]
    assert len(select_products(products, section)) == 1


def test_dyson_sections_require_the_brand():
    section = SECTIONS_BY_SLUG["price_dyson_hair"]
    products = [
        product(brand="Dyson", category="красота", subcategory="Стайлеры"),
        product(brand="Другой", category="красота", subcategory="Стайлеры"),
    ]
    assert len(select_products(products, section)) == 1


# ---------------------------------------------------------------- группировка

def test_subgroups_follow_declared_order():
    section = SECTIONS_BY_SLUG["price_dyson_hair"]
    products = [
        product(brand="Dyson", category="красота", subcategory="Выпрямители", title="В", price=30000),
        product(brand="Dyson", category="красота", subcategory="Стайлеры", title="С", price=40000),
        product(brand="Dyson", category="красота", subcategory="Фены", title="Ф", price=35000),
    ]
    names = [name for name, _ in group_by_subgroup(products, section)]
    assert names == ["Стайлеры", "Фены", "Выпрямители"]


def test_unknown_subgroup_is_not_silently_dropped():
    """Новая подкатегория в каталоге обязана появиться в посте, а не исчезнуть."""
    section = SECTIONS_BY_SLUG["price_dyson_hair"]
    products = [
        product(brand="Dyson", category="красота", subcategory="Стайлеры", title="С"),
        product(brand="Dyson", category="красота", subcategory="Новинки", title="Н"),
    ]
    names = [name for name, _ in group_by_subgroup(products, section)]
    assert names == ["Стайлеры", "Новинки"]


def test_products_are_sorted_deterministically():
    """Случайный порядок дал бы ложный diff и лишнюю правку боевого поста."""
    section = SECTIONS_BY_SLUG["price_iphone"]
    products = [product(title=f"iPhone {i}", price=p) for i, p in enumerate([90000, 70000, 80000])]
    first = render_section(products, section, TODAY, MINI_APP)[0].text
    second = render_section(list(reversed(products)), section, TODAY, MINI_APP)[0].text
    assert first == second
    assert first.index("70 000") < first.index("80 000") < first.index("90 000")


# ---------------------------------------------------------------- текст поста

def test_post_structure():
    section = SECTIONS_BY_SLUG["price_iphone"]
    post = render_section([product()], section, TODAY, MINI_APP, MANAGER)[0]
    assert "IPHONE — АКТУАЛЬНЫЙ ПРАЙС" in post.text
    assert "Цены AI Seller." in post.text
    assert "Наличие, регион и комплектацию подтверждает менеджер." in post.text
    assert "• iPhone 17 Pro 256 Blue — 89 500 ₽" in post.text
    assert "Актуально на: 28.07.2026" in post.text


def test_sku_and_stock_are_never_published():
    section = SECTIONS_BY_SLUG["price_iphone"]
    post = render_section([product(sku="SECRET-SKU", stock=1)], section, TODAY, MINI_APP)[0]
    assert "SECRET-SKU" not in post.text
    assert "Осталась" not in post.text and "шт" not in post.text


def test_html_is_escaped():
    section = SECTIONS_BY_SLUG["price_iphone"]
    post = render_section([product(title="Apple iPhone <b>hack</b> & co")], section, TODAY, MINI_APP)[0]
    assert "<b>hack</b>" not in post.text
    assert "&lt;b&gt;hack&lt;/b&gt;" in post.text
    assert "&amp; co" in post.text


def test_old_price_shown_only_when_it_is_actually_higher():
    section = SECTIONS_BY_SLUG["price_iphone"]
    higher = render_section([product(price=80000, old_price=90000)], section, TODAY, MINI_APP)[0]
    assert "<s>90 000 ₽</s>" in higher.text

    for bogus in (70000, 80000, None):
        post = render_section([product(price=80000, old_price=bogus)], section, TODAY, MINI_APP)[0]
        assert "<s>" not in post.text, bogus


def test_empty_section_produces_no_post():
    assert render_section([], SECTIONS_BY_SLUG["price_iphone"], TODAY, MINI_APP) == []


# ---------------------------------------------------------------- лимит 4096

def test_long_section_is_split_without_cutting_product_lines():
    section = SECTIONS_BY_SLUG["price_iphone"]
    products = [product(sku=f"S{i}", title=f"Apple iPhone 17 Pro {i} Deep Blue Titanium eSIM", price=90000 + i)
                for i in range(200)]
    posts = render_section(products, section, TODAY, MINI_APP, MANAGER)

    assert len(posts) > 1
    for post in posts:
        assert len(post.text) <= TELEGRAM_TEXT_LIMIT
        # Ни одна строка товара не обрезана: у каждой есть и название, и цена.
        for line in post.text.splitlines():
            if line.startswith("•"):
                assert "—" in line and "₽" in line
    # Ни один товар не потерян и не задвоен.
    total = sum(post.item_count for post in posts)
    assert total == len(products)


def test_first_part_keeps_the_base_slug():
    """Иначе уже опубликованный раздел «переедет» на новый id, когда впервые разделится."""
    section = SECTIONS_BY_SLUG["price_iphone"]
    products = [product(sku=f"S{i}", title=f"Apple iPhone Pro Max Titanium Ultra {i}", price=90000 + i)
                for i in range(200)]
    posts = render_section(products, section, TODAY, MINI_APP)
    assert posts[0].slug == "price_iphone"
    assert posts[1].slug == "price_iphone_p2"
    assert all(p.section_slug == "price_iphone" for p in posts)


def test_split_posts_are_numbered_for_the_reader():
    section = SECTIONS_BY_SLUG["price_iphone"]
    products = [product(sku=f"S{i}", title=f"Apple iPhone Pro Max Titanium Ultra {i}", price=90000 + i)
                for i in range(200)]
    posts = render_section(products, section, TODAY, MINI_APP)
    assert f"Часть 1 из {len(posts)}" in posts[0].text


def test_single_post_has_no_part_marker():
    section = SECTIONS_BY_SLUG["price_iphone"]
    post = render_section([product()], section, TODAY, MINI_APP)[0]
    assert "Часть" not in post.text


# ---------------------------------------------------------------- клавиатуры

def test_section_keyboard_layout_and_routes():
    section = SECTIONS_BY_SLUG["price_iphone"]
    post = render_section([product()], section, TODAY, MINI_APP, MANAGER)[0]
    rows = post.keyboard
    assert [len(r) for r in rows] == [1, 2]
    assert rows[0][0]["text"] == "🛍 Открыть раздел"
    assert rows[0][0]["web_app"]["url"] == f"{MINI_APP}/catalog?category=смартфоны&subcategory=iPhone"
    assert rows[1][0]["web_app"]["url"] == f"{MINI_APP}/ai"
    assert rows[1][1]["url"] == MANAGER


def test_buttons_disappear_when_urls_are_not_configured():
    """Пустой url Telegram отвергает вместе со ВСЕМ сообщением."""
    section = SECTIONS_BY_SLUG["price_iphone"]
    post = render_section([product()], section, TODAY, "", "")[0]
    assert post.keyboard == []


@pytest.mark.parametrize("channel_id,expected", [
    (-1003998743702, "https://t.me/c/3998743702/42"),
    ("@isellerhub", "https://t.me/isellerhub/42"),
])
def test_message_link(channel_id, expected):
    assert message_link(channel_id, 42) == expected


def test_navigation_lists_only_published_sections():
    """Кнопка, ведущая в никуда, хуже отсутствующей кнопки."""
    published = {"price_iphone": 10, "price_watch": 12}
    rows = navigation_keyboard(published, -1003998743702, MINI_APP, MANAGER)
    labels = [row[0]["text"] for row in rows]
    assert "📱 iPhone" in labels
    assert "⌚ Apple Watch" in labels
    assert not any("MacBook" in label for label in labels)


def test_navigation_keeps_section_order_and_tail_buttons():
    published = {s.slug: i + 1 for i, s in enumerate(SECTIONS)}
    rows = navigation_keyboard(published, -1003998743702, MINI_APP, MANAGER)
    section_labels = [row[0]["text"] for row in rows[:len(SECTIONS)]]
    assert section_labels == [f"{s.emoji} {s.title}" for s in SECTIONS]
    tail = [b["text"] for row in rows[len(SECTIONS):] for b in row]
    assert tail == ["🛍 Весь каталог", "✨ Подобрать с AI", "💬 Менеджер"]


def test_navigation_text_has_date():
    assert "28.07.2026" in navigation_text(TODAY)


# ---------------------------------------------------------------- fingerprint

def test_fingerprint_changes_with_price_and_ignores_cosmetics():
    products = [product()]
    base = catalog_fingerprint(products)
    assert catalog_fingerprint([product(price=90000)]) != base
    assert catalog_fingerprint([product(is_active=False)]) != base
    # Описание и фото в пост не попадают — перепубликацию провоцировать не должны.
    assert catalog_fingerprint([product(description="другое", image="x.jpg")]) == base


def test_fingerprint_is_order_independent():
    a, b = product(sku="A"), product(sku="B")
    assert catalog_fingerprint([a, b]) == catalog_fingerprint([b, a])


# ---------------------------------------------------------------- diff

def test_parse_lines_reads_published_text_back():
    section = SECTIONS_BY_SLUG["price_iphone"]
    post = render_section([product(price=89500)], section, TODAY, MINI_APP)[0]
    assert parse_lines(post.text) == {"iPhone 17 Pro 256 Blue": 89500.0}


def test_diff_detects_price_change_added_and_removed():
    section = SECTIONS_BY_SLUG["price_iphone"]
    old = render_section(
        [product(sku="A", title="Apple iPhone A", price=80000),
         product(sku="B", title="Apple iPhone B", price=90000)],
        section, TODAY, MINI_APP)[0]
    new = render_section(
        [product(sku="A", title="Apple iPhone A", price=85000),
         product(sku="C", title="Apple iPhone C", price=95000)],
        section, TODAY, MINI_APP)[0]

    diff = diff_posts(old.text, new)
    assert diff.price_changes == [("iPhone A", 80000.0, 85000.0)]
    assert diff.added == ["iPhone C"]
    assert diff.removed == ["iPhone B"]
    assert diff.has_changes


def test_diff_is_empty_when_nothing_changed():
    """Иначе система будет править боевое сообщение на каждом прогоне впустую."""
    section = SECTIONS_BY_SLUG["price_iphone"]
    posts = [render_section([product()], section, TODAY, MINI_APP)[0] for _ in range(2)]
    diff = diff_posts(posts[0].text, posts[1])
    assert not diff.has_changes
    assert diff.price_changes == [] and diff.added == [] and diff.removed == []


def test_diff_against_missing_post_reports_everything_as_new():
    section = SECTIONS_BY_SLUG["price_iphone"]
    new = render_section([product()], section, TODAY, MINI_APP)[0]
    diff = diff_posts("", new)
    assert diff.added == ["iPhone 17 Pro 256 Blue"]
    assert diff.has_changes


def test_diff_flags_over_limit():
    section = SECTIONS_BY_SLUG["price_iphone"]
    post = render_section([product()], section, TODAY, MINI_APP)[0]
    post.text = "x" * (TELEGRAM_TEXT_LIMIT + 1)
    assert diff_posts("", post).over_limit


# ---------------------------------------------------------------- слаги

def test_slugs_are_unique_and_stable():
    slugs = [s.slug for s in SECTIONS]
    assert len(slugs) == len(set(slugs))
    assert NAVIGATION_SLUG not in slugs


def test_render_all_covers_every_section_with_data():
    products = []
    for section in SECTIONS:
        category, subcategory = section.match[0]
        products.append(product(
            sku=f"X-{section.slug}", title=f"{section.brand or 'Apple'} Товар {section.slug}",
            brand=section.brand or "Apple", category=category,
            subcategory=subcategory or (section.subgroups[0] if section.subgroups else None),
        ))
    posts = render_all(products, TODAY, MINI_APP, MANAGER)
    assert {p.section_slug for p in posts} == {s.slug for s in SECTIONS}
