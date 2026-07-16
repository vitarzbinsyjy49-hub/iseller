"""Structured output: парс, repair, устойчивость к мусору от LLM."""
import pytest

from app.services.ai_schemas import AiAnswerParseError, parse_structured_answer

VALID = '{"intent": "product_search", "answer": "Вот варианты", "recommended_product_ids": [1, "2"], "confidence": 0.8}'


def test_parse_valid_json():
    a = parse_structured_answer(VALID)
    assert a.intent == "product_search"
    assert a.recommended_product_ids == [1, 2]  # строки коэрсятся в int
    assert a.confidence == 0.8


def test_parse_fenced_json():
    a = parse_structured_answer(f"```json\n{VALID}\n```")
    assert a.answer == "Вот варианты"


def test_parse_json_with_prose_around():
    a = parse_structured_answer(f"Вот мой ответ: {VALID} Надеюсь, помог!")
    assert a.intent == "product_search"


def test_unknown_intent_maps_to_unsupported():
    a = parse_structured_answer('{"intent": "hack_the_db", "answer": "x"}')
    assert a.intent == "unsupported"


def test_unknown_next_action_maps_to_none():
    a = parse_structured_answer('{"intent": "manager", "answer": "x", "next_action": "rm -rf /"}')
    assert a.next_action == "none"


def test_confidence_clamped():
    a = parse_structured_answer('{"answer": "x", "confidence": 42}')
    assert a.confidence == 1.0


def test_bad_ids_are_skipped():
    a = parse_structured_answer('{"answer": "x", "recommended_product_ids": [3, "oops", null, "7"]}')
    assert a.recommended_product_ids == [3, 7]


@pytest.mark.parametrize("raw", ["", "   ", "не json вообще", '{"answer": }', "[1,2,3]"])
def test_unrepairable_raises(raw):
    with pytest.raises(AiAnswerParseError):
        parse_structured_answer(raw)
