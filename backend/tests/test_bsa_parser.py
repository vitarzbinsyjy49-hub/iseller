"""Разбор прайса поставщика: ошибка здесь = неверная цена на витрине."""
from pathlib import Path

import pytest

from app.services.bsa_parser import parse, parse_line
from app.services.price_posts import split_region

DUMP = Path(__file__).resolve().parents[1] / "app" / "scripts" / "data" / "bsa_2026_08_11.txt"


def test_price_with_dots_and_glued_dash():
    item = parse_line("17 Pro 256 Silver-99.800🇭🇰🇰🇷(1sim+e sim)")
    assert item.price == 99800
    assert item.model == "17 Pro"
    assert item.storage == "256 ГБ"
    assert item.color == "Silver"
    assert item.regions == ["HK", "KR"]
    assert item.sim == "SIM+eSIM"


def test_price_with_spaces_as_thousands():
    """«ASIS 🇺🇸 102 000» — разряды пробелом, цена отделена от названия."""
    item = parse_line("17 Pro 512 Silver ASIS 🇺🇸 102 000")
    assert item.price == 102000
    assert item.asis is True
    assert item.regions == ["US"]


def test_russian_letter_in_e_sim_is_recognised():
    """В прайсе «е sim» набрано русской «е» — на вид не отличить."""
    item = parse_line("17 Pro 256 Silver-97.900🇯🇵е sim")
    assert item.sim == "eSIM"
    assert item.price == 97900


def test_activated_device_is_marked():
    item = parse_line("17 Pro Max 256 Blue-97.000🇺🇸е sim актив")
    assert item.activated is True
    assert item.price == 97000


def test_mist_blue_is_the_same_colour_as_blue():
    """У поставщика два написания одного цвета корпуса — фото у них общее."""
    assert parse_line("17 512 Mist Blue ASIS 🇺🇸 76 000").color == "Blue"


def test_title_carries_region_as_codes_for_the_storefront():
    """Регион в скобках кодами: флаг из него сделает split_region, один на всех."""
    item = parse_line("17 Pro Max 512 Blue-128.500🇰🇷🇭🇰(1sim+e sim)")
    assert item.title == "Apple iPhone 17 Pro Max 512 ГБ Blue (KR-HK, SIM+eSIM)"

    flags, clean = split_region(item.title)
    assert flags == "🇰🇷🇭🇰"
    assert clean == "Apple iPhone 17 Pro Max 512 ГБ Blue (SIM+eSIM)"


def test_sku_separates_variants_that_differ_only_by_region():
    """Одна модель из разных регионов — разные позиции с разной ценой."""
    hk = parse_line("17 Pro 256 Silver-99.800🇭🇰🇰🇷(1sim+e sim)")
    jp = parse_line("17 Pro 256 Silver-97.900🇯🇵е sim")
    assert hk.sku != jp.sku
    assert hk.price != jp.price


def test_headers_and_blank_lines_are_not_products():
    assert parse_line("## iPhone 17 Pro") is None
    assert parse_line("") is None


def test_whole_dump_parses_without_losses():
    """Ни одна строка с ценой не должна потеряться молча."""
    items, failed = parse(DUMP.read_text(encoding="utf-8"))
    assert failed == [], f"не разобраны: {failed}"
    assert len(items) >= 100

    # Артикулы уникальны: иначе импорт склеит разные позиции в одну.
    skus = [i.sku for i in items]
    duplicates = {s for s in skus if skus.count(s) > 1}
    assert not duplicates, f"дубли артикулов: {duplicates}"


@pytest.mark.parametrize("model,expected", [
    ("17 Pro Max", 29), ("17 Pro", 26), ("17e", 9), ("17", 38),
])
def test_counts_match_the_source(model, expected):
    """Счётчики по моделям — защита от «разобралось, но не всё»."""
    items, _ = parse(DUMP.read_text(encoding="utf-8"))
    assert sum(1 for i in items if i.model == model) == expected


# ------------------------------------------------- компьютеры и мониторы

MAC_DUMP = DUMP.parent / "bsa_mac_2026_08_11.txt"


def test_mac_mini_with_bracket_article():
    from app.services.bsa_parser import parse_mac_line

    item = parse_mac_line("🇮🇳🇺🇸🇭🇰🍏[MU9D3] Mac Mini M4 (16/256)—63.000*")
    assert item.price == 63000
    assert item.article == "MU9D3"
    assert item.title == "Mac Mini M4 (16/256)"
    assert item.regions == ["IN", "US", "HK"]
    assert item.category == "компьютеры"


def test_display_article_after_pipe():
    from app.services.bsa_parser import parse_mac_line

    item = parse_mac_line("🇷🇺Studio Display Standart Glass Tilt Stand | MYJG3R  - 189.000")
    assert item.price == 189000
    assert item.article == "MYJG3R"
    assert item.category == "мониторы"


def test_article_with_digits_is_not_read_as_price():
    """«Z1E800069» содержит 800069 — без снятия артикула это стало бы ценой."""
    from app.services.bsa_parser import parse_mac_line

    item = parse_mac_line("🇸🇬🖥[Z1E800069] iMac M4 (8/8/16/256) Orange Рус 🔌 — 178500")
    assert item.price == 178500
    assert item.article == "Z1E800069"
    assert item.title == "iMac M4 (8/8/16/256) Orange"


def test_same_article_in_two_regions_stays_two_products():
    """MWUU3 в прайсе дважды: 🇺🇸 192 000 и 🇷🇺 194 000 — это разные позиции."""
    from app.services.bsa_parser import parse_mac_line

    us = parse_mac_line("🇺🇸🖥[MWUU3] iMac M4 (10/10/16/256) Silver — 192000")
    ru = parse_mac_line("🇷🇺🖥[MWUU3] iMac M4 (10/10/16/256) Silver — 194000")
    assert us.sku != ru.sku
    assert (us.price, ru.price) == (192000, 194000)


def test_mac_studio_without_article_or_flags():
    from app.services.bsa_parser import parse_mac_line

    item = parse_mac_line("Mac Studio M3 Ultra 32 80 96GB 1TB - 850000")
    assert item.price == 850000
    assert item.regions == []
    assert item.category == "компьютеры"
    assert "Mac Studio M3 Ultra" in item.title


def test_accessory_goes_to_its_own_category():
    from app.services.bsa_parser import parse_mac_line

    item = parse_mac_line("🇷🇺Magic Keyboard с Touch ID MK293RS/A  — 16.600")
    assert item.price == 16600
    assert item.category == "аксессуары"


def test_whole_mac_dump_parses_without_losses():
    from app.services.bsa_parser import parse_mac

    items, failed = parse_mac(MAC_DUMP.read_text(encoding="utf-8"))
    assert failed == [], f"не разобраны: {failed}"

    skus = [i.sku for i in items]
    duplicates = {s for s in skus if skus.count(s) > 1}
    assert not duplicates, f"дубли артикулов: {duplicates}"
    assert len(items) >= 60


def test_seven_digit_price_without_separators():
    """«1020000» — миллион, а не сто две тысячи.

    Регрессия: предел \d{4,6} обрезал число до шести цифр, и Mac Studio за
    1 020 000 уходил в каталог по 102 000. Поймано предпросмотром поста, где
    «Mac Studio — от 101 500 ₽» бросилось в глаза рядом с трёхмиллионными.
    """
    from app.services.bsa_parser import parse_mac_line

    assert parse_mac_line("Mac Studio M4 Max 128 2TB - 1020000").price == 1020000
    assert parse_mac_line("Mac Studio M4 Max 128 4TB - 1170000").price == 1170000
    # С разделителями разбиралось и раньше — проверяем, что не сломали.
    assert parse_mac_line("Mac Studio M3 Ultra 512 1TB - 2.800.000").price == 2800000


def test_cheapest_mac_studio_is_the_real_minimum():
    """Минимум по семье уходит в пост «от N ₽» — ошибка тут видна покупателю."""
    from app.services.bsa_parser import parse_mac

    items, _ = parse_mac(MAC_DUMP.read_text(encoding="utf-8"))
    studio = [i.price for i in items if i.title.lower().startswith("mac studio")]
    assert min(studio) == 490000
    assert max(studio) == 3800000
