"""Санитайзер денежных утверждений (v5.1): текст LLM не может врать про цены."""
from app.services.ai_facts import NEUTRAL_FALLBACK, sanitize_money_claims
from tests.conftest import make_product


def test_fake_price_sentence_removed(db):
    p = make_product(db, price=119990)
    text, removed = sanitize_money_claims("Хороший телефон. Отдам за 10 рублей!", [p])
    assert "10 рублей" not in text
    assert "Хороший телефон" in text
    assert removed == 1


def test_real_price_kept(db):
    p = make_product(db, price=119990)
    text, removed = sanitize_money_claims("Стоит 119 990 ₽ и в наличии.", [p])
    assert "119 990" in text
    assert removed == 0


def test_old_price_and_saving_kept(db):
    p = make_product(db, price=100000, old_price=129990)
    text, removed = sanitize_money_claims("Раньше стоил 129 990 руб, выгода 29 990 ₽.", [p])
    assert removed == 0


def test_thousands_form_kept(db):
    p = make_product(db, price=120000)
    text, removed = sanitize_money_claims("Обойдётся примерно в 120 тыс ₽.", [p])
    assert removed == 0


def test_all_sentences_bad_gives_neutral(db):
    p = make_product(db, price=119990)
    text, removed = sanitize_money_claims("Отдам за 5 рублей.", [p])
    assert text == NEUTRAL_FALLBACK
    assert removed == 1


def test_no_products_any_money_removed(db):
    text, removed = sanitize_money_claims("Могу продать за 99 999 ₽.", [])
    assert removed == 1
    assert text == NEUTRAL_FALLBACK


def test_text_without_money_untouched(db):
    p = make_product(db)
    src = "Лёгкий корпус, яркий экран. Подходит для монтажа."
    text, removed = sanitize_money_claims(src, [p])
    assert text == src
    assert removed == 0
