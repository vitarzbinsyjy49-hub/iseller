"""Сверка цен с BSA: строки -> справочные цены -> расхождения (09.10.2026)."""
from datetime import datetime, timedelta, timezone

from app.models.price_ref import PriceLink
from app.services import bsa_fetch, price_sync
from app.services.source_lines import parse_text
from tests.conftest import make_product
from tests.test_staff_prices import _staff, client  # noqa: F401 — фикстура

POST = """MacBook Air
🇺🇸MDVH4 Air 15 Midnight (M5, 16GB, 512GB) -133.000
🇮🇳🇺🇸[MDHE4] Air 13 (M5 16/512) Midnight-114..000
🇭🇰 HS08 Amber Silk — 40.000
17 Pro 256 Silver-102.700🇭🇰🇰🇷(1sim+e sim)
17 Pro 256 Silver-94.500🇺🇸е sim актив 🔥
🇮🇳🇺🇸💻MGE74 MacBook Pro 16 M5 Max 18/32 36GB 2TB Silver-327.000
🇮🇳 💻[MGE74] Pro 16 M5 Max (18c CPU/32c GPU/36/2Tb) Silver — 371000
"""


def test_line_keys():
    keys = {sl.key: sl.price for sl in parse_text(POST)}
    assert keys["art:MDVH4"] == 133000
    assert keys["art:MDHE4"] == 114000                     # «114..000» — опечатка BSA
    assert keys["txt:hk hs08 amber silk"] == 40000
    assert keys["ip:IP-17PRO-256-SILVER-HKKR-SIM"] == 102700
    assert not any("94500" in str(v) for v in keys.values() if v == 94500)  # актив не берём


def test_the_mdvh4_case_is_caught(db):
    """Тот самый случай: у нас 120 000, у BSA 133 000."""
    p = make_product(db, title="MacBook Air 15 Midnight", sku="MDVH4", price=120000)
    price_sync.seed_links(db)
    price_sync.ingest_text(db, POST)
    diffs, stats = price_sync.discrepancies(db)
    assert [(d.sku, d.our_price, d.ref.suggested) for d in diffs] == [("MDVH4", 120000, 132500)]
    assert stats["linked"] == 1 and stats["checked"] == 1


def test_same_article_two_lines_picks_by_link_text(db):
    p = make_product(db, title="MacBook Pro 16", sku="MGE74", price=326500)
    price_sync.link(db, p.id, "art:MGE74",
                    "🇮🇳🇺🇸💻MGE74 MacBook Pro 16 M5 Max 18/32 36GB 2TB Silver-327.000", "seed")
    price_sync.ingest_text(db, POST)
    ref = price_sync.reference_for(db, [p.id])[p.id]
    assert ref.price == 327000


def test_link_heals_when_supplier_rewords_line(db):
    p = make_product(db, title="Dyson HS08 Amber Silk (HK)", sku="DYS-HS08-AMB-SLK-HK", price=39500)
    price_sync.link(db, p.id, "txt:hk hs08 amber silk", "🇭🇰 HS08 Amber Silk — 40.000", "seed")
    old = datetime.now(timezone.utc) - timedelta(days=3)
    price_sync.ingest_text(db, "🇭🇰 HS08 Amber Silk — 40.000", now=old)
    price_sync.ingest_text(db, "🇭🇰 HS08 Amber Silk  — 41.000")   # лишний пробел — ключ тот же
    assert price_sync.reference_for(db, [p.id])[p.id].price == 41000
    price_sync.ingest_text(db, "🇭🇰 HS08 Amber/Silk — 42.000", now=datetime.now(timezone.utc) + timedelta(days=2))
    ref = price_sync.reference_for(db, [p.id], heal=True,
                                   now=datetime.now(timezone.utc) + timedelta(days=2))[p.id]
    assert ref.healed and ref.price == 42000
    assert db.query(PriceLink).one().origin == "healed"


def test_stale_reference_is_not_a_discrepancy(db):
    p = make_product(db, sku="MDVH4", price=1)
    price_sync.seed_links(db)
    price_sync.ingest_text(db, POST, now=datetime.now(timezone.utc) - timedelta(days=5))
    diffs, stats = price_sync.discrepancies(db, heal=False)
    assert diffs == [] and stats["missing_today"] == 1


def test_export_reader_takes_rich_posts():
    raw = ('{"messages":[{"id":1,"type":"message","text":"",'
           '"rich_message":{"blocks":[{"type":"paragraph","text":"17 Pro 256 Silver-102.700🇭🇰🇰🇷(1sim+e sim)"}]}},'
           '{"id":2,"type":"message","text":[{"type":"bold","text":"MDVH4 Air"}," -133.000"]}]}').encode()
    texts = bsa_fetch.parse_export(raw)
    assert "102.700" in texts[1] and "133.000" in texts[2]


def test_embed_text_extraction():
    page = ('<div class="tgme_widget_message_text js-message_text" dir="auto">🇺🇸MDVH4 Air 15 -133.000<br/>'
            'MDVQ4 - 131.000</div>\n<div class="tgme_widget_message_footer">')
    assert bsa_fetch.embed_to_text(page) == "🇺🇸MDVH4 Air 15 -133.000\nMDVQ4 - 131.000"


def test_staff_sees_bsa_and_applies_it(client, db):  # noqa: F811
    p = make_product(db, title="MacBook Air 15 Midnight", sku="MDVH4", price=120000)
    price_sync.seed_links(db)
    price_sync.ingest_text(db, POST)
    db.commit()
    rows = client.get("/api/staff/products?filter=diff", headers=_staff()).json()["items"]
    assert [(r["sku"], r["bsa"]["price"], r["bsa"]["suggested"]) for r in rows] == [("MDVH4", 133000, 132500)]
    r = client.post(f"/api/staff/products/{p.id}/apply-bsa", headers=_staff()).json()
    assert r["price"] == 132500
    assert client.get("/api/staff/products?filter=diff", headers=_staff()).json()["items"] == []


def test_reworded_into_other_product_is_not_healed(db):
    """«Amber Silk» -> «Amber Silk Gold» может быть другим товаром — не угадываем."""
    p = make_product(db, sku="DYS-X", price=39500)
    price_sync.link(db, p.id, "txt:hk hs08 amber silk", "🇭🇰 HS08 Amber Silk — 40.000", "seed")
    later = datetime.now(timezone.utc) + timedelta(days=2)
    price_sync.ingest_text(db, "🇭🇰 HS08 Amber Silk Gold — 42.000", now=later)
    assert p.id not in price_sync.reference_for(db, [p.id], heal=True, now=later)


def test_daily_check_applies_bsa_minus_500_and_holds_big_jumps(db, monkeypatch):
    from app.core.config import settings
    from app.models.price_change import PriceChange
    from app.services import daily_bsa_check, staff_auth
    monkeypatch.setattr(settings, "BSA_AUTO_APPLY", True)
    monkeypatch.setattr(settings, "ADMIN_TELEGRAM_IDS", "1")
    sent = []
    monkeypatch.setattr(staff_auth, "notify", lambda chat, text, **kw: sent.append(text) or True)
    small = make_product(db, title="MacBook Air 15 M5 512 Midnight", sku="MDVH4", price=130000)
    big = make_product(db, title="MacBook Air 13 M5 512 Midnight", sku="MDHE4", price=60000)
    price_sync.seed_links(db)
    stats = daily_bsa_check.run(db, texts={12459: POST}, failed=[])
    db.refresh(small); db.refresh(big)
    assert float(small.price) == 132500                  # +1.9% — применено
    assert float(big.price) == 60000                     # +89% — ждёт подтверждения
    assert stats["applied"] == 1 and stats["held"] == 1
    change = db.query(PriceChange).one()
    assert (change.source, change.actor) == ("bsa", "system")
    assert "Изменено цен: 1" in sent[0] and "Ждут подтверждения: 1" in sent[0]


def test_export_source_detection():
    assert bsa_fetch.export_source("BSA Store") == "bsa"
    assert bsa_fetch.export_source("apostl price") == "apostl"
    assert bsa_fetch.export_source("Какой-то канал") is None


def test_iphone_key_ignores_flag_order():
    a = parse_text("17 Pro 256 Silver-104.000🇭🇰🇰🇷(1sim+e sim)")[0].key
    b = parse_text("17 Pro 256 Silver-104.000🇰🇷🇭🇰(1sim+e sim)")[0].key
    assert a == b
