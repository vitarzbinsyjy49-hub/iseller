"""Оркестратор AI-эскалации сценарного чата: никогда не роняет флоу заявки."""
import asyncio
import json

import pytest

import app.services.scenario_chat as scenario_chat
from app.core.config import settings
from app.services.ai_remote import AIGatewayError


def run(coro):
    return asyncio.run(coro)


def _fake(payload: dict):
    async def fake(**kwargs):
        return {"content": json.dumps(payload, ensure_ascii=False), "model": "test", "total_ms": 5}
    return fake


OPTIONS = [
    {"value": "excellent", "label": "Отличное"},
    {"value": "normal", "label": "Нормальное"},
    {"value": "damaged", "label": "Есть повреждения"},
    {"value": "dead", "label": "Не включается"},
]


@pytest.fixture(autouse=True)
def anthropic_provider(monkeypatch):
    monkeypatch.setattr(settings, "AI_PROVIDER", "anthropic", raising=False)


def test_field_value_within_options_returned(monkeypatch):
    monkeypatch.setattr(scenario_chat, "_call_transport", _fake(
        {"type": "field_value", "value": "damaged", "reply": None},
    ))
    ans = run(scenario_chat.answer_scenario_turn(
        scenario="trade_in", field_key="condition", options=OPTIONS, message="экран треснул",
    ))
    assert ans == {"type": "field_value", "value": "damaged", "reply": None}


def test_field_value_outside_options_dropped_to_unclear(monkeypatch):
    """LLM не может подставить значение, которого не предлагали — то же
    правило, что recommended_product_ids ⊆ candidates в основном оркестраторе."""
    monkeypatch.setattr(scenario_chat, "_call_transport", _fake(
        {"type": "field_value", "value": "brand_new_in_box", "reply": None},
    ))
    ans = run(scenario_chat.answer_scenario_turn(
        scenario="trade_in", field_key="condition", options=OPTIONS, message="почти новый",
    ))
    assert ans["type"] == "unclear"


def test_answer_question_passed_through(monkeypatch):
    monkeypatch.setattr(scenario_chat, "_call_transport", _fake(
        {"type": "answer_question", "value": None, "reply": "Гарантия 1 месяц с покупки."},
    ))
    ans = run(scenario_chat.answer_scenario_turn(
        scenario="trade_in", field_key="condition", options=OPTIONS, message="а гарантия есть?",
    ))
    assert ans["type"] == "answer_question"
    assert "Гарантия 1 месяц" in ans["reply"]


def test_gateway_down_degrades_to_unclear_not_raises(monkeypatch):
    async def down(**kwargs):
        raise AIGatewayError("unreachable")
    monkeypatch.setattr(scenario_chat, "_call_transport", down)
    ans = run(scenario_chat.answer_scenario_turn(
        scenario="trade_in", field_key="condition", options=OPTIONS, message="сломан",
    ))
    assert ans == {"type": "unclear", "value": None, "reply": None}


def test_invalid_json_degrades_to_unclear(monkeypatch):
    async def garbage(**kwargs):
        return {"content": "не json", "model": "test", "total_ms": 1}
    monkeypatch.setattr(scenario_chat, "_call_transport", garbage)
    ans = run(scenario_chat.answer_scenario_turn(
        scenario="trade_in", field_key="condition", options=OPTIONS, message="сломан",
    ))
    assert ans["type"] == "unclear"


def test_non_anthropic_provider_never_calls_transport(monkeypatch):
    """Mac-mini гейтвей для сценарного чата не реализован (вне скоупа) —
    любой другой провайдер сразу деградирует, сети не касаясь."""
    monkeypatch.setattr(settings, "AI_PROVIDER", "fallback", raising=False)

    async def boom(**kwargs):
        raise AssertionError("transport must not be called for non-anthropic provider")
    monkeypatch.setattr(scenario_chat, "_call_transport", boom)
    ans = run(scenario_chat.answer_scenario_turn(
        scenario="trade_in", field_key="condition", options=OPTIONS, message="сломан",
    ))
    assert ans == {"type": "unclear", "value": None, "reply": None}


def test_empty_message_is_unclear_without_network(monkeypatch):
    async def boom(**kwargs):
        raise AssertionError("transport must not be called for empty message")
    monkeypatch.setattr(scenario_chat, "_call_transport", boom)
    ans = run(scenario_chat.answer_scenario_turn(
        scenario="trade_in", field_key="condition", options=OPTIONS, message="   ",
    ))
    assert ans == {"type": "unclear", "value": None, "reply": None}
