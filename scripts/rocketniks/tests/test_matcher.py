"""Matcher unit tests — colour/generation/size conflicts, ANC, scoring, statuses.

Pure, offline. Candidates are hand-written dicts mirroring the Rocketniks
``/api/search`` item shape ({name, vendorCode, url, color?}).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from scripts.rocketniks import colors, matcher  # noqa: E402


# ---------------- colour vocabulary ----------------
@pytest.mark.parametrize("value,expected", [
    ("белый", "white"),
    ("Полуночный", "midnight"),
    ("Sky Blue", "sky blue"),
    ("керамический розовый", "ceramic pink"),
    ("розовое золото", "rose gold"),
    ("шалфей", "sage"),
])
def test_canon_color_ru_en(value, expected):
    assert colors.canon_color(value) == expected


def test_find_colors_phrase_wins_over_word():
    # "space gray" must not be read as bare "gray"
    assert colors.find_colors("MacBook Pro Space Gray") == {"space gray"}
    assert "gray" not in colors.find_colors("Space Gray")


# ---------------- normalisation ----------------
def test_normalize_query_strips_region_sim_memory():
    q = matcher.normalize_query("Apple iPhone 17 256 GB Sage (IN, SIM+eSIM)")
    assert "256" not in q and "(in" not in q.lower() and "sim" not in q.lower()
    assert "iphone 17" in q.lower() and "sage" in q.lower()


# ---------------- exact article ----------------
def test_exact_article_prefix_macbook():
    m = matcher.score_candidate(
        "MW1L3", "Apple MacBook Air 15 Midnight (M4 16/256)",
        {"name": 'Apple MacBook Air 15" M4 (2025) 16GB 256GB полуночный', "vendorCode": "MW1L3R"},
    )
    assert any("article" in x for x in m.matched)
    assert m.score >= 90 and m.status == "exact" and not m.conflicts


# ---------------- generation conflict (iPhone) ----------------
def test_iphone_generation_conflict_blocks_auto():
    m = matcher.score_candidate(
        "APL-IP16", "Apple iPhone 16 Black",
        {"name": "Apple iPhone 17 256GB черный", "vendorCode": "X"},
    )
    assert m.conflicts and m.status == "rejected"


# ---------------- colour conflict (Sage → white) ----------------
def test_color_conflict_sage_vs_white_rejected():
    m = matcher.match_product(
        "APL-IP17-256-SAGE-IN", "Apple iPhone 17 256 GB Sage (IN, SIM+eSIM)",
        [{"name": "Apple iPhone 17 256GB eSIM+eSIM белый", "vendorCode": "MG474L"}],
    )
    assert m.status == "rejected"
    assert any("color" in c for c in m.conflicts)


# ---------------- size conflict (Watch 46 vs 42mm) ----------------
def test_watch_size_conflict_and_correct_variant_wins():
    cands = [
        {"name": "Apple Watch Series 11 42мм S/M розовое золото", "vendorCode": "MEU04Z"},
        {"name": "Apple Watch Series 11 46мм S/M розовое золото", "vendorCode": "MEV64M"},
    ]
    m = matcher.match_product("AW-S11-46", "Apple Watch Series 11 46mm Rose Gold S/M", cands)
    assert "MEV64M" == m.candidate["vendorCode"]      # 46mm variant chosen
    assert not m.conflicts and m.status in ("exact", "likely")
    # the 42mm candidate alone is a hard size conflict
    only42 = matcher.score_candidate("AW-S11-46", "Apple Watch Series 11 46mm Rose Gold S/M", cands[0])
    assert only42.conflicts and only42.status == "rejected"


# ---------------- AirPods Max year (soft) → review ----------------
def test_airpods_max_year_soft_conflict_review():
    # when the candidate name exposes a different year on the same USB-C body,
    # it's a SOFT conflict → review (never auto), colour still matches.
    m = matcher.score_candidate(
        "APL-APD-MAX-2026-BLU", "Apple AirPods Max 2026 Blue (US)",
        {"name": "Apple AirPods Max 2024 (USB Type-C) синий", "vendorCode": "MWW63-B", "color": "синий"},
    )
    assert m.status == "review"
    assert m.soft_conflicts and not m.conflicts


def test_airpods_max_no_year_on_candidate_is_likely():
    # search items carry no year; colour+model match with no conflict → applicable
    m = matcher.score_candidate(
        "APL-APD-MAX-2026-BLU", "Apple AirPods Max 2026 Blue (US)",
        {"name": "Apple AirPods Max (с разъёмом USB Type-C) синий", "vendorCode": "MWW63-B", "color": "синий"},
    )
    assert m.status in ("likely", "review") and not m.conflicts


# ---------------- AirPods ANC vs non-ANC ----------------
def test_airpods_anc_vs_non_anc_not_auto():
    m = matcher.score_candidate(
        "APL-APD4-ANC", "Apple AirPods 4 ANC (2024)",
        {"name": "Apple AirPods 4 (без ANC)", "vendorCode": "Y"},
    )
    assert m.status != "exact" and (m.soft_conflicts or m.conflicts)


# ---------------- Dyson model-code match & conflict ----------------
def test_dyson_code_matches_pink():
    m = matcher.score_candidate(
        "DYS-HD16-CER-PNK-CN", "Dyson HD16 Ceramic Pink (CN)",
        {"name": "Dyson Supersonic Nural HD16 керамический розовый", "vendorCode": "598973-02", "color": "керамический розовый"},
    )
    assert any("dyson-code" in x for x in m.matched)
    assert any("color" in x for x in m.matched)
    assert not m.conflicts and m.status in ("likely", "exact", "review")


def test_dyson_code_conflict_hd16_vs_hd17():
    m = matcher.score_candidate(
        "DYS-HD16-CER-PNK", "Dyson HD16 Ceramic Pink",
        {"name": "Dyson HD17 керамический розовый", "vendorCode": "Z"},
    )
    assert any("dyson-code" in c for c in m.conflicts) and m.status == "rejected"


# ---------------- not_found ----------------
def test_no_candidates_not_found():
    m = matcher.match_product("X", "Whatever", [])
    assert m.status == "not_found"


def test_search_noise_no_model_overlap_is_not_found():
    # source doesn't carry the product; search returns an unrelated item →
    # not_found (not a false "rejected" that implies a real-but-wrong candidate)
    m = matcher.match_product(
        "SONY-PS-5-PORTAL-BLK", "PlayStation 5 Portal Black",
        [{"name": "Apple iPad Pro 13 M5 2025", "vendorCode": "X"}],
    )
    assert m.status == "not_found"


# ---------------- Cyrillic homoglyph in source colour ----------------
def test_cyrillic_homoglyph_color_detected():
    # "Bluе" ends with a Cyrillic 'е' in the real catalogue data
    assert colors.find_colors("Apple iPhone Air Bluе") == {"blue"}
    # → a gold candidate must now be a colour conflict, not a silent match
    m = matcher.score_candidate(
        "APL-IPAIR-BLU", "Apple iPhone Air 512 Bluе (JP)",
        {"name": "Apple iPhone Air 256GB золотистый", "vendorCode": "MG1A4L", "color": "золотистый"},
    )
    assert any("color" in c for c in m.conflicts) and m.status == "rejected"


# ---------------- colour unknown on our side, candidate colour-specific → review ----------------
def test_both_exclusive_colors_downgrade_to_review():
    # shared finish (topaz) but different primary (apricot vs blue) → review, not likely
    m = matcher.score_candidate(
        "DYS-HS08-APRICOT-TOPAZ", "Dyson HS08 Apricot Topaz",
        {"name": "Dyson Airwrap HS08 синие румяна/топаз", "vendorCode": "X", "color": "синие румяна/топаз"},
    )
    assert m.status == "review" and not m.conflicts


def test_superset_color_still_matches():
    # candidate colourway is a superset (ceramic pink + rose gold) → still a match
    m = matcher.score_candidate(
        "DYS-HD16-CER-PNK", "Dyson HD16 Ceramic Pink",
        {"name": "Dyson HD16 керамический розовый/розовое золото", "vendorCode": "X",
         "color": "керамический розовый/розовое золото"},
    )
    assert m.status in ("likely", "exact") and not m.conflicts


def test_unreadable_our_color_downgrades_to_review():
    # our colour "Yell/Nick" isn't in the vocabulary; candidate is grey/gold →
    # we must not auto-apply → review, never likely/exact
    m = matcher.score_candidate(
        "DYS-V12-YELL-NICK", "Dyson V12 Detect Slim Absolute SV46 (Yell/Nick)",
        {"name": "Dyson V12 Detect Slim Absolute серый/золотой", "vendorCode": "X", "color": "серый/золотой"},
    )
    assert m.status == "review"


# ---------------- visual grouping key (memory/SIM don't split) ----------------
def test_visual_signature_ignores_memory_and_sim():
    a = matcher.signature("Apple iPhone 17 256GB eSIM+eSIM белый")
    b = matcher.signature("Apple iPhone 17 512GB nano-Sim белый")
    assert a.colors == b.colors == {"white"}
    assert a.iphone_gen == b.iphone_gen == {"17"}
