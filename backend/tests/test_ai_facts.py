"""Санитайзер денежных утверждений (v5.1.1): БЕЗ whitelist — любое денежное
утверждение в тексте LLM удаляется; цены пользователь видит только в карточках."""
import pytest

from app.services.ai_facts import NEUTRAL_FALLBACK, sanitize_money_claims
from tests.conftest import make_product


@pytest.mark.parametrize("phrase", [
    "Отдам за 10 ₽.",
    "Отдам за 10 руб.",
    "Всего 10 рублей.",
    "Стоит 10 р. сейчас.",
    "Цена 10 000 ₽.",
    "Отдам за 10к.",
    "Отдам за 10k.",
    "Примерно 10 тыс.",
    "Около 10 тысяч.",
    "Цена 10 000.",
    "Стоит 10 000.",
    "Стоимость 10 000.",
    "Отдам за 10 000.",
    "Скидка 10 000.",
    "Скидка 90k!",
    "Выгода 10 000.",
    "Дешевле на 10 000.",
    "Дороже на 10 000.",
])
def test_money_claims_removed(phrase):
    text, removed = sanitize_money_claims(f"Хороший вариант. {phrase}")
    assert removed == 1, phrase
    assert "Хороший вариант" in text


def test_candidate_price_is_not_a_licence(db):
    """Цена одного кандидата не разрешает приписывать её другому товару:
    whitelist отменён — даже точная цена из БД в тексте удаляется."""
    p = make_product(db, price=119990)
    text, removed = sanitize_money_claims("Стоит 119 990 ₽ — в рамках бюджета.", [p])
    assert removed == 1
    assert "119 990" not in text


@pytest.mark.parametrize("phrase", [
    "Рекомендую iPhone 16 Pro 256 GB.",
    "Для монтажа лучше 16 GB RAM.",
    "Чип M4 Pro справится с рендером.",
    "Экран 4K и 120 Гц.",
    "Накопитель 512 ГБ, памяти 16 ГБ.",
])
def test_specs_and_models_kept(phrase):
    text, removed = sanitize_money_claims(phrase)
    assert removed == 0, phrase
    assert text == phrase


def test_all_sentences_bad_gives_neutral():
    text, removed = sanitize_money_claims("Отдам за 5 рублей.")
    assert text == NEUTRAL_FALLBACK
    assert removed == 1


def test_mixed_text_partial_removal():
    src = "Лёгкий корпус и яркий экран. Отдам за 10к. Подходит для монтажа."
    text, removed = sanitize_money_claims(src)
    assert removed == 1
    assert "10к" not in text
    assert "Лёгкий корпус" in text and "для монтажа" in text
