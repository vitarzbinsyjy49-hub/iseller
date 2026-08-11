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
