# Trade-In / Для бизнеса / Опт — AI-чат вместо форм — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить статичные bottom-sheet формы Trade-In / Для бизнеса / Опт на чат с ИИ, где скрипт ведёт сбор той же структурированной заявки без модели, а модель подключается только когда клиентский матчинг не справился или пользователь задал вопрос.

**Architecture:** Клиентский стейт-машин (`scenarioChat.ts`) ведёт переходы между шагами анкеты (те же поля, что сегодня в `scenario.ts`) чисто локально — тап по чипу или совпавший по синонимам свободный текст двигают диалог без сети. Backend получает запрос (`POST /api/scenario-chat/turn`) только когда локальный матчинг не смог разрешить ответ или он похож на вопрос; эндпоинт использует тот же транспорт Anthropic, что и `/ai/chat`, отвечает строго из зафиксированного FAQ и никогда не роняет флоу — при любой недоступности AI возвращает `{"type":"unclear"}`, а фронт продолжает без модели. `POST /api/leads` и админка не меняются: те же `lead_type`/`metadata`.

**Tech Stack:** FastAPI + Pydantic + SQLAlchemy + pytest (backend); React + TypeScript + React Router + vitest (frontend); Anthropic Messages API через `app/services/ai_anthropic.py`.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md` — все решения этого плана обязаны ей соответствовать.
- Контракт `Lead`/`POST /api/leads`/админка **не меняются**.
- `scenario_chat.py` поддерживает **только** `AI_PROVIDER=anthropic` (прод-транспорт); для остальных значений (`ollama_remote`/`ai`/`fallback`/`mock`) сразу возвращает `{"type":"unclear"}` без сетевого вызова — реализация Mac-mini гейтвея для сценарного чата вне скоупа.
- AI никогда не выдумывает цифры/сроки вне зафиксированного FAQ-блока в `backend/app/prompts/scenario_chat_system.md`.
- Локальный dev-стенд по умолчанию `AI_PROVIDER=fallback` (`docker-compose.demo.yml`) — эскалация в проде вручную не проверяется без ключа, но обязана возвращать `unclear`, не падать.
- Новые события аналитики регистрируются **и** в `frontend/src/lib/analytics.ts` (`AppEvent`), **и** в `backend/app/schemas/ai.py` (`ALLOWED_EVENTS`) — иначе `test_event_allowlist_sync.py` падает.
- Frontend: только vitest на чистую логику (`.test.ts`, без DOM) — в проекте нет тестов React-компонентов страниц, конвенцию не нарушаем.
- Backend-тесты: `cd backend && python -m pytest -q`. Frontend: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`.

---

## Task 1: `ai_schemas.py` — общий JSON-repair + `ScenarioTurnAnswer`

**Files:**
- Modify: `backend/app/services/ai_schemas.py`
- Test: `backend/tests/test_ai_schemas.py`

**Interfaces:**
- Produces: `parse_scenario_turn(raw: str) -> ScenarioTurnAnswer`, `ScenarioTurnAnswer` (поля `type: str`, `value: str | None`, `reply: str | None`), `SCENARIO_TURN_TYPES: set[str]`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `backend/tests/test_ai_schemas.py`:

```python
# ---------- сценарный чат (Trade-In/бизнес/опт) ----------

from app.services.ai_schemas import ScenarioTurnAnswer, parse_scenario_turn  # noqa: E402


def test_parse_scenario_turn_field_value():
    a = parse_scenario_turn('{"type": "field_value", "value": "damaged", "reply": null}')
    assert a.type == "field_value"
    assert a.value == "damaged"
    assert a.reply is None


def test_parse_scenario_turn_answer_question():
    a = parse_scenario_turn('{"type": "answer_question", "value": null, "reply": "Гарантия 1 месяц."}')
    assert a.type == "answer_question"
    assert a.reply == "Гарантия 1 месяц."


def test_parse_scenario_turn_fenced_json():
    a = parse_scenario_turn('```json\n{"type": "unclear", "value": null, "reply": "Не понял"}\n```')
    assert a.type == "unclear"


def test_parse_scenario_turn_unknown_type_becomes_unclear():
    a = parse_scenario_turn('{"type": "delete_database", "value": null, "reply": null}')
    assert a.type == "unclear"


@pytest.mark.parametrize("raw", ["", "   ", "не json вообще", '{"type": }'])
def test_parse_scenario_turn_unrepairable_raises(raw):
    with pytest.raises(AiAnswerParseError):
        parse_scenario_turn(raw)


def test_scenario_turn_reply_length_capped():
    long_reply = "x" * 500
    a = ScenarioTurnAnswer.model_validate({"type": "answer_question", "reply": long_reply})
    assert len(a.reply) <= 300
```

Добавить `import pytest` в начало файла, если его там ещё нет (проверить первые строки — сейчас файл начинается с `import pytest` уже на строке 2, дополнительно ничего добавлять не нужно).

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && python -m pytest tests/test_ai_schemas.py -k scenario_turn -v`
Expected: FAIL — `ImportError: cannot import name 'ScenarioTurnAnswer'`.

- [ ] **Step 3: Рефакторинг репair-парсинга в общую функцию**

В `backend/app/services/ai_schemas.py` заменить тело `parse_structured_answer` — вынести цикл repair в приватную `_repair_to_dict`, используемую и новым парсером:

```python
def _repair_to_dict(raw: str) -> dict:
    """Строгий парс -> одна попытка repair -> словарь. Общий шаг для всех
    структурированных ответов LLM (основной чат и сценарный чат)."""
    if not raw or not raw.strip():
        raise AiAnswerParseError("empty LLM output")

    candidates = [raw.strip()]
    cleaned = _FENCE_RE.sub("", raw).strip()
    if cleaned != candidates[0]:
        candidates.append(cleaned)
    extracted = _extract_first_object(cleaned)
    if extracted and extracted not in candidates:
        candidates.append(extracted)

    last_error: Exception | None = None
    for candidate in candidates:
        try:
            data = json.loads(candidate)
            if not isinstance(data, dict):
                raise ValueError("top-level JSON is not an object")
            return data
        except (ValueError,) as e:
            last_error = e
    raise AiAnswerParseError(f"unparseable LLM output: {last_error}") from last_error


def parse_structured_answer(raw: str) -> AiStructuredAnswer:
    try:
        return AiStructuredAnswer.model_validate(_repair_to_dict(raw))
    except ValidationError as e:
        raise AiAnswerParseError(f"unparseable LLM output: {e}") from e
```

Убедиться, что `ValidationError` уже импортирован (он есть — используется в `field_validator`).

- [ ] **Step 4: Добавить `ScenarioTurnAnswer` и `parse_scenario_turn`**

Добавить в конец `backend/app/services/ai_schemas.py`:

```python
# ---------- сценарный чат (Trade-In/бизнес/опт, v6) ----------
# Компактный контракт AI-эскалации: см.
# docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md. Вызывается
# ТОЛЬКО когда клиентский скрипт не смог сам разобрать ответ покупателя.

SCENARIO_TURN_TYPES = {"field_value", "answer_question", "unclear"}


class ScenarioTurnAnswer(BaseModel):
    type: str = "unclear"
    value: str | None = Field(default=None, max_length=40)
    reply: str | None = Field(default=None, max_length=300)

    @field_validator("type", mode="before")
    @classmethod
    def _type_known(cls, v):
        v = str(v or "").strip().lower()
        return v if v in SCENARIO_TURN_TYPES else "unclear"


def parse_scenario_turn(raw: str) -> ScenarioTurnAnswer:
    """Строгий парс ответа AI-эскалации сценарного чата -> repair -> валидация."""
    try:
        return ScenarioTurnAnswer.model_validate(_repair_to_dict(raw))
    except ValidationError as e:
        raise AiAnswerParseError(f"unparseable LLM output: {e}") from e
```

- [ ] **Step 5: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_ai_schemas.py -v`
Expected: все PASS (старые + новые), поведение `parse_structured_answer` не изменилось.

- [ ] **Step 6: Прогнать весь backend — рефакторинг не сломал соседей**

Run: `cd backend && python -m pytest -q`
Expected: все тесты проходят (то же количество + 6 новых).

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/ai_schemas.py backend/tests/test_ai_schemas.py
git commit -m "feat(ai): схема и парсер ответа сценарного AI-чата (ScenarioTurnAnswer)"
```

---

## Task 2: `ai_anthropic.py` — `call_scenario_turn`

**Files:**
- Modify: `backend/app/services/ai_anthropic.py`
- Test: `backend/tests/test_ai_anthropic.py`

**Interfaces:**
- Consumes: `AIGatewayError` (из `ai_remote`), `settings.AI_ANTHROPIC_API_KEY/MODEL`, `_client()` (уже существует в файле).
- Produces: `async def call_scenario_turn(*, system: str, message: str) -> dict` → `{content, model, total_ms}` (тот же контракт, что `call_anthropic`/`call_gateway`).

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `backend/tests/test_ai_anthropic.py`:

```python
# ---------- call_scenario_turn (сценарный AI-чат) ----------

from app.services.ai_anthropic import call_scenario_turn  # noqa: E402


def test_scenario_turn_returns_gateway_shaped_dict(monkeypatch, anthropic_key):
    _stub(monkeypatch, _Resp('{"type": "field_value", "value": "damaged", "reply": null}'))
    got = run(call_scenario_turn(system="S", message="m"))
    assert set(got) == {"content", "model", "total_ms"}
    assert got["content"] == '{"type": "field_value", "value": "damaged", "reply": null}'


def test_scenario_turn_uses_configured_model_no_schema(monkeypatch, anthropic_key):
    """Компактный вызов без structured outputs — короткий ответ, JSON гарантирован
    промптом + repair-парсером (parse_scenario_turn)."""
    monkeypatch.setattr(settings, "AI_ANTHROPIC_MODEL", "claude-haiku-4-5", raising=False)
    captured = _stub(monkeypatch, _Resp('{"type": "unclear", "value": null, "reply": null}'))
    run(call_scenario_turn(system="СИСТЕМНЫЙ ПРОМПТ", message="m"))
    assert captured["model"] == "claude-haiku-4-5"
    assert captured["system"] == "СИСТЕМНЫЙ ПРОМПТ"
    assert [m["role"] for m in captured["messages"]] == ["user"]
    assert "output_config" not in captured


def test_scenario_turn_missing_key_is_error(monkeypatch):
    monkeypatch.setattr(settings, "AI_ANTHROPIC_API_KEY", "", raising=False)
    ai_anthropic._client.cache_clear()
    with pytest.raises(AIGatewayError):
        run(call_scenario_turn(system="S", message="m"))


@pytest.mark.parametrize("exc_cls,status", [
    (anthropic.RateLimitError, 429),
    (anthropic.AuthenticationError, 401),
])
def test_scenario_turn_api_errors_become_gateway_error(monkeypatch, anthropic_key, exc_cls, status):
    _stub(monkeypatch, _err(exc_cls, status))
    with pytest.raises(AIGatewayError):
        run(call_scenario_turn(system="S", message="m"))


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_scenario_turn_bad_stop_reason_becomes_gateway_error(monkeypatch, anthropic_key, stop_reason):
    _stub(monkeypatch, _Resp('{"type": "uncl', stop_reason=stop_reason))
    with pytest.raises(AIGatewayError):
        run(call_scenario_turn(system="S", message="m"))


def test_scenario_turn_empty_content_becomes_gateway_error(monkeypatch, anthropic_key):
    _stub(monkeypatch, _Resp("   "))
    with pytest.raises(AIGatewayError):
        run(call_scenario_turn(system="S", message="m"))
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && python -m pytest tests/test_ai_anthropic.py -k scenario_turn -v`
Expected: FAIL — `ImportError: cannot import name 'call_scenario_turn'`.

- [ ] **Step 3: Реализовать `call_scenario_turn`**

Добавить в конец `backend/app/services/ai_anthropic.py`:

```python
async def call_scenario_turn(*, system: str, message: str) -> dict:
    """Компактный вызов для AI-эскалации сценарного чата (Trade-In/бизнес/опт).

    Без structured outputs (`output_config`): ответ короткий (type/value/reply),
    JSON гарантирован промптом + repair-парсером `parse_scenario_turn` — заводить
    вторую JSON-схему ради трёх полей избыточно. Контракт возврата такой же, как
    у `call_anthropic`/`call_gateway`: {content, model, total_ms}.
    """
    if not settings.AI_ANTHROPIC_API_KEY:
        raise AIGatewayError("Anthropic is not configured (AI_ANTHROPIC_API_KEY)")

    t0 = time.monotonic()
    try:
        resp = await _client().messages.create(
            model=settings.AI_ANTHROPIC_MODEL,
            max_tokens=300,
            system=system,
            messages=[{"role": "user", "content": message}],
        )
    except anthropic.RateLimitError as e:
        logger.warning("Anthropic rate limited (scenario turn)")
        raise AIGatewayError("Anthropic rate limited") from e
    except anthropic.APIStatusError as e:
        logger.warning("Anthropic HTTP %s (scenario turn)", e.status_code)
        raise AIGatewayError(f"Anthropic returned HTTP {e.status_code}") from e
    except anthropic.APIConnectionError as e:
        logger.warning("Anthropic unreachable (scenario turn): %s", type(e).__name__)
        raise AIGatewayError("Anthropic unreachable") from e

    if resp.stop_reason == "refusal":
        logger.warning("Anthropic refused the request (scenario turn)")
        raise AIGatewayError("Anthropic refused the request")
    if resp.stop_reason == "max_tokens":
        logger.warning("Anthropic response truncated by max_tokens (scenario turn)")
        raise AIGatewayError("Anthropic response truncated")

    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if not text:
        raise AIGatewayError("Anthropic returned empty content")

    return {
        "content": text,
        "model": resp.model,
        "total_ms": int((time.monotonic() - t0) * 1000),
    }
```

- [ ] **Step 4: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_ai_anthropic.py -v`
Expected: все PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/ai_anthropic.py backend/tests/test_ai_anthropic.py
git commit -m "feat(ai): call_scenario_turn — компактный Anthropic-вызов для сценарного чата"
```

---

## Task 3: Системный промпт сценарного чата

**Files:**
- Create: `backend/app/prompts/scenario_chat_system.md`

**Interfaces:**
- Consumes: ничего (статический текстовый файл).
- Produces: читается `backend/app/services/scenario_chat.py` (Task 4) через `Path.read_text()`.

- [ ] **Step 1: Создать файл**

```markdown
Ты помогаешь оформить заявку в магазине техники AI Seller — Trade-In, поставка
для бизнеса или оптовая заявка. Тебе присылают ТЕКУЩИЙ вопрос анкеты (и,
если у вопроса есть варианты ответа, список VARIANTS) и ответ покупателя.

Верни СТРОГО JSON без пояснений вокруг:
{"type": "field_value" | "answer_question" | "unclear", "value": string|null, "reply": string|null}

Правила:
- "field_value" — ответ покупателя явно соответствует одному из VARIANTS.
  "value" ОБЯЗАН быть значением поля "value" одного из VARIANTS (не label,
  не придуманное значение). Если VARIANTS не переданы — "field_value" не
  используй, это поле свободного текста.
- "answer_question" — покупатель вместо ответа задал вопрос или возражение
  (например "сколько это будет стоить", "а гарантия есть"). "reply" — КОРОТКИЙ
  ответ (1-2 предложения), СТРОГО из FAQ ниже. Если факта в FAQ нет — не
  придумывай его, вместо этого скажи, что детали уточнит менеджер после заявки.
- "unclear" — ответ не подходит ни под один вариант и не похож на вопрос.
  "reply" можно оставить null — вызывающий сам подставит нейтральную фразу.

FAQ — единственный источник фактов для "answer_question", ничего сверх него
не утверждай:
- Гарантия 1 месяц с момента покупки на всю технику из прайса.
- Проверка техники вместе с покупателем до оплаты (включаем устройство,
  смотрим внешний вид и работу основных функций).
- Самовывоз — Горбушка, Москва, ежедневно 10:00–21:00, можно приехать в день
  обращения, без записи заранее.
- Доставка по Москве курьером.
- Оплата наличными при получении — на самовывозе после проверки, курьеру при
  доставке.
- Точную оценку, цену и сроки называет профильный менеджер после того, как
  заявка отправлена — сам не называй ни одной цифры и ни одного срока, которых
  нет в этом списке.
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/prompts/scenario_chat_system.md
git commit -m "feat(ai): системный промпт сценарного AI-чата (FAQ-ограниченный)"
```

---

## Task 4: `scenario_chat.py` — оркестратор AI-эскалации

**Files:**
- Create: `backend/app/services/scenario_chat.py`
- Test: `backend/tests/test_scenario_chat.py`

**Interfaces:**
- Consumes: `ai_orchestrator._sanitize` (переиспользуется, уже существует и экспортирована как модульная функция), `ai_anthropic.call_scenario_turn`, `ai_schemas.parse_scenario_turn`/`AiAnswerParseError`, `ai_remote.AIGatewayError`, `settings.AI_PROVIDER`.
- Produces: `async def answer_scenario_turn(*, scenario: str, field_key: str, options: list[dict], message: str) -> dict` → `{"type": ..., "value": ..., "reply": ...}`, никогда не бросает исключение.

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/tests/test_scenario_chat.py`:

```python
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
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && python -m pytest tests/test_scenario_chat.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.scenario_chat'`.

- [ ] **Step 3: Реализовать `scenario_chat.py`**

```python
"""Оркестратор AI-эскалации сценарного чата (Trade-In/бизнес/опт).

Вызывается ТОЛЬКО когда клиентский скрипт (frontend/src/lib/scenarioChat.ts)
сам не смог разобрать ответ покупателя — см.
docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md. Никогда не
бросает исключение наружу: при любой недоступности AI возвращает
{"type": "unclear"}, чтобы экран чата продолжил работу без модели.

Поддерживает только AI_PROVIDER=anthropic (прод-транспорт) — реализация
Mac-mini гейтвея для сценарного чата вне скоупа этого патча.
"""
import logging
from functools import lru_cache
from pathlib import Path

from app.core.config import settings
from app.services.ai_orchestrator import _sanitize
from app.services.ai_remote import AIGatewayError
from app.services.ai_schemas import AiAnswerParseError, parse_scenario_turn

logger = logging.getLogger("techshop.ai.scenario_chat")
_PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "scenario_chat_system.md"

_UNCLEAR: dict = {"type": "unclear", "value": None, "reply": None}


@lru_cache(maxsize=1)
def _system_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _build_user_message(scenario: str, field_key: str, options: list[dict], message: str) -> str:
    parts = [f"СЦЕНАРИЙ: {scenario}", f"ТЕКУЩИЙ ВОПРОС АНКЕТЫ: {field_key}"]
    if options:
        variants = ", ".join(f'{{"value":"{o["value"]}","label":"{o["label"]}"}}' for o in options)
        parts.append(f"VARIANTS: [{variants}]")
    parts.append(f"ОТВЕТ ПОКУПАТЕЛЯ: {message}")
    return "\n".join(parts)


async def _call_transport(*, system: str, message: str) -> dict:
    """Единственная точка входа в сеть — подменяется в тестах.
    Импорт ленивый: модуль тянет SDK anthropic, который нужен только здесь."""
    from app.services import ai_anthropic
    return await ai_anthropic.call_scenario_turn(system=system, message=message)


async def answer_scenario_turn(*, scenario: str, field_key: str, options: list[dict], message: str) -> dict:
    """Возвращает {"type": "field_value"|"answer_question"|"unclear", "value", "reply"}.

    ``options`` — [{"value","label"}, ...] текущего chips-поля (пусто для
    свободного текста). Никогда не бросает исключение.
    """
    message = _sanitize(message, max_len=500)
    if not message:
        return dict(_UNCLEAR)
    if settings.AI_PROVIDER.lower() != "anthropic":
        return dict(_UNCLEAR)

    user_message = _build_user_message(scenario, field_key, options, message)
    try:
        gw = await _call_transport(system=_system_prompt(), message=user_message)
        parsed = parse_scenario_turn(gw["content"])
    except (AIGatewayError, AiAnswerParseError, OSError, ImportError) as e:
        logger.warning("Scenario chat AI degraded to unclear: %s", type(e).__name__)
        return dict(_UNCLEAR)

    allowed_values = {o["value"] for o in options}
    if parsed.type == "field_value" and parsed.value not in allowed_values:
        logger.warning("Scenario chat LLM returned value outside options — dropped")
        return dict(_UNCLEAR)

    return {"type": parsed.type, "value": parsed.value, "reply": parsed.reply}
```

Проверить, что `_sanitize` в `ai_orchestrator.py` действительно принимает `max_len` вторым именованным параметром (см. `backend/app/services/ai_orchestrator.py`, сигнатура `_sanitize(text: str, max_len: int = 1000)`) — это уже так, ничего менять в `ai_orchestrator.py` не нужно.

- [ ] **Step 4: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_scenario_chat.py -v`
Expected: все PASS.

- [ ] **Step 5: Прогнать весь backend**

Run: `cd backend && python -m pytest -q`
Expected: все тесты проходят.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/scenario_chat.py backend/tests/test_scenario_chat.py
git commit -m "feat(ai): оркестратор AI-эскалации сценарного чата (answer_scenario_turn)"
```

---

## Task 5: `schemas/ai.py` — вход эндпоинта + новые события аналитики

**Files:**
- Modify: `backend/app/schemas/ai.py`

**Interfaces:**
- Produces: `ScenarioChatOptionIn`, `ScenarioChatTurnIn` (поля `scenario`, `field_key`, `options`, `message`) — использует Task 6.

- [ ] **Step 1: Добавить pydantic-модели**

Добавить в `backend/app/schemas/ai.py` после `AiChatIn`:

```python
class ScenarioChatOptionIn(BaseModel):
    value: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=80)


class ScenarioChatTurnIn(BaseModel):
    """Вход POST /api/scenario-chat/turn — AI-эскалация сценарного чата.
    Отправляется фронтом ТОЛЬКО когда клиентский матчинг не справился."""
    scenario: str = Field(pattern="^(trade_in|b2b|wholesale)$")
    field_key: str = Field(min_length=1, max_length=40)
    options: list[ScenarioChatOptionIn] = Field(default_factory=list, max_length=10)
    message: str = Field(min_length=1, max_length=500)
```

- [ ] **Step 2: Зарегистрировать новые события аналитики**

В `ALLOWED_EVENTS` (`backend/app/schemas/ai.py`) добавить после `"scenario_lead_failed",`:

```python
    # v6: сценарный AI-чат вместо форм. scenario_chat_opened — открытие
    # экрана /apply/<scenario>; scenario_chat_ai_escalated — сколько раз шаг
    # реально ушёл в модель (метрика того, что скрипт держит нагрузку сам).
    "scenario_chat_opened",
    "scenario_chat_ai_escalated",
```

- [ ] **Step 3: Проверить, что pydantic-модели валидны**

Run: `cd backend && python -c "from app.schemas.ai import ScenarioChatTurnIn; print(ScenarioChatTurnIn(scenario='trade_in', field_key='condition', options=[{'value':'damaged','label':'Повреждения'}], message='треснул'))"`
Expected: печатает объект без ошибок.

- [ ] **Step 4: Commit**

```bash
git add backend/app/schemas/ai.py
git commit -m "feat(ai): схема входа scenario-chat/turn + события аналитики v6"
```

(Тест синхронизации событий фронт/бэк — `test_event_allowlist_sync.py` — будет зелёным только после Task 11, где событие появляется во фронтовом `AppEvent`. Это ожидаемо: запускать `test_event_allowlist_sync.py` изолированно на этом шаге не нужно.)

---

## Task 6: `POST /api/scenario-chat/turn` — эндпоинт

**Files:**
- Create: `backend/app/api/scenario_chat.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_scenario_chat.py` (дополнить)

**Interfaces:**
- Consumes: `ScenarioChatTurnIn` (Task 5), `answer_scenario_turn` (Task 4), `get_current_user`/`client_ip` (`app/api/deps.py`), `check_rate_limit` (`app/core/rate_limit.py`).

- [ ] **Step 1: Написать падающие тесты эндпоинта**

Добавить в конец `backend/tests/test_scenario_chat.py`. Аутентификация в тестах — не реальный JWT, а `app.dependency_overrides` поверх `get_current_user`/`get_db`, тот же приём, что уже используется в `backend/tests/test_leads_scenario.py` (фикстура `ctx` там же):

```python
# ---------- HTTP-эндпоинт ----------

from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User


@pytest.fixture()
def api_ctx(db):
    u = User(telegram_id=601, first_name="Тест", username="testuser")
    db.add(u)
    db.commit()
    db.refresh(u)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_turn_endpoint_happy_path(monkeypatch, api_ctx):
    async def fake(**kwargs):
        return {"type": "field_value", "value": "damaged", "reply": None}
    monkeypatch.setattr("app.api.scenario_chat.answer_scenario_turn", fake)
    res = api_ctx.post(
        "/api/scenario-chat/turn",
        json={
            "scenario": "trade_in", "field_key": "condition",
            "options": [{"value": "damaged", "label": "Повреждения"}],
            "message": "треснул экран",
        },
    )
    assert res.status_code == 200
    assert res.json() == {"type": "field_value", "value": "damaged", "reply": None}


def test_turn_endpoint_requires_auth(db):
    """Без dependency_overrides реальный get_current_user отклоняет запрос
    без валидного JWT — так же, как /api/ai/chat."""
    client = TestClient(app)
    res = client.post(
        "/api/scenario-chat/turn",
        json={"scenario": "trade_in", "field_key": "condition", "options": [], "message": "x"},
    )
    assert res.status_code in (401, 403)


def test_turn_endpoint_rejects_unknown_scenario(api_ctx):
    res = api_ctx.post(
        "/api/scenario-chat/turn",
        json={"scenario": "hacking", "field_key": "condition", "options": [], "message": "x"},
    )
    assert res.status_code == 422


def test_turn_endpoint_rate_limited(monkeypatch, api_ctx):
    monkeypatch.setattr("app.api.scenario_chat.check_rate_limit", lambda *a, **kw: False)
    res = api_ctx.post(
        "/api/scenario-chat/turn",
        json={"scenario": "trade_in", "field_key": "condition", "options": [], "message": "x"},
    )
    assert res.status_code == 429
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && python -m pytest tests/test_scenario_chat.py -k turn_endpoint -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.api.scenario_chat'` (роут ещё не существует).

- [ ] **Step 3: Реализовать эндпоинт**

Создать `backend/app/api/scenario_chat.py`:

```python
"""POST /api/scenario-chat/turn — AI-эскалация сценарного чата.

Вызывается фронтом ТОЛЬКО когда клиентский скрипт сам не смог разобрать ответ
покупателя — см. docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md.
Использует тот же rate-limit ключ, что /ai/chat: это тот же AI-бюджет
пользователя, отдельный счётчик не заводим.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.deps import client_ip, get_current_user
from app.core.rate_limit import check_rate_limit
from app.models.user import User
from app.schemas.ai import ScenarioChatTurnIn
from app.services.scenario_chat import answer_scenario_turn

router = APIRouter(prefix="/scenario-chat", tags=["scenario-chat"])


@router.post("/turn")
async def turn(
    body: ScenarioChatTurnIn,
    request: Request,
    user: User = Depends(get_current_user),
):
    rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
    if not check_rate_limit(rl_key):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many AI requests. Please try again later.",
        )
    options = [{"value": o.value, "label": o.label} for o in body.options]
    return await answer_scenario_turn(
        scenario=body.scenario, field_key=body.field_key, options=options, message=body.message,
    )
```

- [ ] **Step 4: Зарегистрировать роутер**

В `backend/app/main.py`:

Строку
```python
from app.api import admin, admin_crm, admin_promo, admin_users, ai, auth, cart, catalog, config as config_api, deeplink, events, favorites, health, home, imports, leads, loyalty, posts, price_posts, telegram, users
```
заменить на (добавлен `scenario_chat`, алфавитный порядок сохранён):
```python
from app.api import admin, admin_crm, admin_promo, admin_users, ai, auth, cart, catalog, config as config_api, deeplink, events, favorites, health, home, imports, leads, loyalty, posts, price_posts, scenario_chat, telegram, users
```

После строки `app.include_router(ai.router, prefix="/api")` добавить:
```python
app.include_router(scenario_chat.router, prefix="/api")
```

- [ ] **Step 5: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_scenario_chat.py -v`
Expected: все PASS.

- [ ] **Step 6: Прогнать весь backend**

Run: `cd backend && python -m pytest -q`
Expected: все тесты проходят.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/scenario_chat.py backend/app/main.py backend/tests/test_scenario_chat.py
git commit -m "feat(api): POST /api/scenario-chat/turn — эндпоинт AI-эскалации"
```

---

## Task 7: `ai_orchestrator.py` — действие «Оформить заявку» рядом с «Написать менеджеру»

**Files:**
- Modify: `backend/app/services/ai_orchestrator.py`
- Test: `backend/tests/test_ai_orchestrator.py`

**Interfaces:**
- Produces: расширяет `actions` в ответе `answer_via_local_ai` для intent ∈ {trade_in,b2b,wholesale} действием `{"type":"scenario","label":...,"scenario":intent}`.

- [ ] **Step 1: Написать падающий тест**

Добавить в `backend/tests/test_ai_orchestrator.py` после `test_deterministic_intents_skip_llm`:

```python
@pytest.mark.parametrize("q,intent", [
    ("хочу оптом партию", "wholesale"),
    ("что такое trade-in?", "trade_in"),
    ("поставка для компании со счётом", "b2b"),
])
def test_deterministic_scenario_intents_offer_scenario_action(db, q, intent, monkeypatch):
    """Trade-In/бизнес/опт получают действие «Оформить заявку» ПЕРВЫМ —
    заявка внутри приложения важнее ухода в Telegram к менеджеру."""
    async def boom(**kwargs):
        raise AssertionError("gateway must not be called for deterministic intents")
    monkeypatch.setattr(orch, "call_gateway", boom)
    ans = run(orch.answer_via_local_ai(db, q, []))
    types = [a["type"] for a in ans["actions"]]
    assert types == ["scenario", "manager"]
    scenario_action = ans["actions"][0]
    assert scenario_action["scenario"] == intent
    assert scenario_action["label"]


def test_llm_scenario_intent_offers_scenario_action(db, monkeypatch):
    """Тот же приоритет и на пути через модель (не только детерминированный)."""
    monkeypatch.setattr(orch, "call_gateway", _gw_response({
        "answer": "Понял, поможем с оптом.", "intent": "wholesale", "next_action": "open_manager",
    }))
    ans = run(orch.answer_via_local_ai(db, "нужна партия ноутбуков от 30 штук", []))
    types = [a["type"] for a in ans["actions"]]
    assert types == ["scenario", "manager"]
    assert ans["actions"][0]["scenario"] == "wholesale"
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && python -m pytest tests/test_ai_orchestrator.py -k scenario_action -v`
Expected: FAIL — `assert ["manager"] == ["scenario", "manager"]`.

- [ ] **Step 3: Реализовать**

В `backend/app/services/ai_orchestrator.py` добавить рядом с `_MANAGER_LABEL`:

```python
# CTA действия «Оформить заявку» — приоритетнее ухода к менеджеру: заявка
# формируется прямо в приложении, менеджер уже видит структурированные данные.
_SCENARIO_CTA = {
    "trade_in": "Оформить Trade-In",
    "b2b": "Оставить заявку для бизнеса",
    "wholesale": "Оставить оптовую заявку",
}
```

В `_deterministic_answer` заменить блок формирования ответа:

```python
    for intent, role, keywords, answer in _DETERMINISTIC:
        if not any(k in low for k in keywords):
            continue
        # «не хочу менеджера, подбери сам» — это запрос на подбор, а не контакт
        if intent == "manager" and (_MANAGER_NEGATION_RE.search(low) or substantive):
            continue
        return {"text": answer, "cards": [],
                "actions": [{"type": "manager", "label": _MANAGER_LABEL[role], "manager_role": role}],
                "meta": {"source": "rules", "intent": intent}}
```

на:

```python
    for intent, role, keywords, answer in _DETERMINISTIC:
        if not any(k in low for k in keywords):
            continue
        # «не хочу менеджера, подбери сам» — это запрос на подбор, а не контакт
        if intent == "manager" and (_MANAGER_NEGATION_RE.search(low) or substantive):
            continue
        actions: list[dict] = []
        if intent in _SCENARIO_CTA:
            actions.append({"type": "scenario", "label": _SCENARIO_CTA[intent], "scenario": intent})
        actions.append({"type": "manager", "label": _MANAGER_LABEL[role], "manager_role": role})
        return {"text": answer, "cards": [], "actions": actions,
                "meta": {"source": "rules", "intent": intent}}
```

Далее в конце `answer_via_local_ai` заменить:

```python
    if structured.next_action == "open_manager" or structured.intent in ("wholesale", "b2b", "trade_in", "manager"):
        role = structured.intent if structured.intent in ("wholesale", "b2b", "trade_in") else "retail"
        actions.append({"type": "manager", "label": _MANAGER_LABEL[role], "manager_role": role})
```

на:

```python
    if structured.next_action == "open_manager" or structured.intent in ("wholesale", "b2b", "trade_in", "manager"):
        role = structured.intent if structured.intent in ("wholesale", "b2b", "trade_in") else "retail"
        if structured.intent in _SCENARIO_CTA:
            actions.append({"type": "scenario", "label": _SCENARIO_CTA[structured.intent], "scenario": structured.intent})
        actions.append({"type": "manager", "label": _MANAGER_LABEL[role], "manager_role": role})
```

- [ ] **Step 4: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_ai_orchestrator.py -v`
Expected: все PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/ai_orchestrator.py backend/tests/test_ai_orchestrator.py
git commit -m "feat(ai): действие «Оформить заявку» рядом с «Написать менеджеру» в /ai чате"
```

---

## Task 8: Backend checkpoint

**Files:** нет изменений — только проверка.

- [ ] **Step 1: Полный прогон backend-тестов**

Run: `cd backend && python -m pytest -q`
Expected: все тесты проходят (базовые 774/791 + новые из Tasks 1,2,4,6,7).

- [ ] **Step 2: Если что-то красное — остановиться и исправить перед переходом к фронтенду**

Backend — фундамент для фронтенда (Task 14 дёргает `POST /api/scenario-chat/turn` вживую в браузере). Не продолжать с падающими тестами.

---

## Task 9: `lib/scenario.ts` — синонимы chips + `intro`/`closingHook`

**Files:**
- Modify: `frontend/src/lib/scenario.ts`
- Test: `frontend/src/lib/scenario.test.ts`

**Interfaces:**
- Produces: `OptionItem.synonyms?: string[]`, `ScenarioConfig.intro: string`, `ScenarioConfig.closingHook: string`. Существующие экспорты (`SCENARIOS`, `buildScenarioLead`, `validateScenario`, `MACBOOK_CHOICES`) не меняют сигнатуры.

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `frontend/src/lib/scenario.test.ts`:

```typescript
describe("SCENARIOS intro/closingHook/synonyms", () => {
  it("у каждого сценария есть непустые intro и closingHook", () => {
    for (const key of ["trade_in", "b2b", "wholesale"] as const) {
      expect(SCENARIOS[key].intro.length).toBeGreaterThan(10);
      expect(SCENARIOS[key].closingHook.length).toBeGreaterThan(10);
    }
  });

  it("chips-поля с несколькими вариантами имеют синонимы хотя бы у части опций", () => {
    const conditionField = SCENARIOS.trade_in.fields.find((f) => f.key === "condition");
    expect(conditionField?.kind).toBe("chips");
    if (conditionField?.kind === "chips") {
      const damaged = conditionField.options.find((o) => o.value === "damaged");
      expect(damaged?.synonyms?.length).toBeGreaterThan(0);
      expect(damaged?.synonyms).toContain("треснул");
    }
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd frontend && npx vitest run scenario.test.ts`
Expected: FAIL — `SCENARIOS.trade_in.intro` is `undefined`.

- [ ] **Step 3: Расширить типы и данные**

В `frontend/src/lib/scenario.ts` заменить:

```typescript
export type OptionItem = { value: string; label: string };
```

на:

```typescript
export type OptionItem = { value: string; label: string; synonyms?: string[] };
```

Заменить:

```typescript
export type ScenarioConfig = {
  leadType: ScenarioKey;
  title: string;
  subtitle: string;
  cta: string;
  managerRole: "trade_in" | "b2b" | "wholesale";
  fields: Field[];
};
```

на:

```typescript
export type ScenarioConfig = {
  leadType: ScenarioKey;
  title: string;
  subtitle: string;
  cta: string;
  managerRole: "trade_in" | "b2b" | "wholesale";
  fields: Field[];
  /** Вступительная реплика AI-чата (scenario_chat.ts) — статика, без модели. */
  intro: string;
  /** Реплика перед кнопкой отправки заявки — статика, без модели. */
  closingHook: string;
};
```

Заменить весь блок `SCENARIOS` на версию с `intro`/`closingHook`/синонимами (структура полей и порядок ключей — те же, что сейчас, только добавлены три новых свойства и `synonyms` у части опций):

```typescript
export const SCENARIOS: Record<ScenarioKey, ScenarioConfig> = {
  trade_in: {
    leadType: "trade_in",
    title: "Trade-In — оценка устройства",
    subtitle: "Пара шагов, и менеджер пришлёт оценку",
    cta: "Получить оценку",
    managerRole: "trade_in",
    intro: "Оценим вашу технику и предложим обмен на новое устройство или выкуп. "
      + "Самовывоз в Москве ежедневно 10:00–21:00 — можно приехать в день обращения, "
      + "оценка и расчёт при проверке устройства.",
    closingHook: "Проверьте данные ниже и отправьте заявку — её рассмотрит trade-in "
      + "менеджер, обычно в течение дня.",
    fields: [
      { kind: "chips", key: "device_type", label: "Тип устройства", required: true, options: [
        { value: "iphone", label: "iPhone", synonyms: ["айфон", "apple phone"] },
        { value: "macbook", label: "MacBook", synonyms: ["макбук", "ноутбук apple"] },
        { value: "ipad", label: "iPad", synonyms: ["айпад", "планшет apple"] },
        { value: "apple_watch", label: "Apple Watch", synonyms: ["часы", "эпл вотч", "эппл вотч"] },
        { value: "other", label: "Другое", synonyms: ["другое", "иное"] }] },
      { kind: "text", key: "model", label: "Модель", required: true, placeholder: "Напр. iPhone 15 Pro", target: "metadata" },
      { kind: "text", key: "memory", label: "Память (необязательно)", placeholder: "256 ГБ", target: "metadata" },
      { kind: "chips", key: "condition", label: "Состояние", required: true, options: [
        { value: "excellent", label: "Отличное", synonyms: ["идеальное", "как новый", "без царапин"] },
        { value: "normal", label: "Нормальное", synonyms: ["б/у", "бу", "обычное", "потёртости"] },
        { value: "damaged", label: "Есть повреждения", synonyms: ["треснул", "разбит", "скол", "трещина", "поцарапан"] },
        { value: "dead", label: "Не включается", synonyms: ["не работает", "дохлый", "кирпич"] }] },
      { kind: "chips", key: "intent", label: "Что хотите сделать", required: true, options: [
        { value: "exchange", label: "Обменять на другое", synonyms: ["обменять", "обмен", "поменять"] },
        { value: "sell", label: "Продать", synonyms: ["продажа", "выкуп", "выкупите"] }] },
      { kind: "text", key: "desired_device", label: "Что хотите получить (необязательно)", placeholder: "Напр. iPhone 16 Pro", target: "metadata" },
      { kind: "textarea", key: "message", label: "Комментарий (необязательно)", placeholder: "Комплектация, состояние…" },
    ],
  },
  b2b: {
    leadType: "b2b",
    title: "Для бизнеса — подберём поставку",
    subtitle: "Оставьте вводные, пришлём предложение",
    cta: "Получить предложение",
    managerRole: "b2b",
    intro: "Подберём поставку под вашу компанию: смартфоны, ноутбуки, техника для "
      + "сотрудников. Документы для юрлиц, оплата по счёту — детали обсудит менеджер.",
    closingHook: "Проверьте данные ниже и отправьте заявку — B2B-менеджер пришлёт "
      + "предложение под ваш объём.",
    fields: [
      { kind: "chips", key: "equipment", label: "Что требуется", required: true, options: [
        { value: "smartphones", label: "Смартфоны", synonyms: ["телефоны"] },
        { value: "laptops", label: "Ноутбуки", synonyms: ["ноутбук", "макбуки", "ноуты"] },
        { value: "tablets", label: "Планшеты", synonyms: ["планшет", "айпады"] },
        { value: "staff_devices", label: "Техника для сотрудников", synonyms: ["сотрудники", "персонал", "команда"] },
        { value: "complex", label: "Комплексная поставка", synonyms: ["всё сразу", "полная поставка"] },
        { value: "other", label: "Другое", synonyms: ["другое", "иное"] }] },
      { kind: "chips", key: "quantity_range", label: "Примерное количество", required: true, options: [
        { value: "1-5", label: "1–5" }, { value: "5-20", label: "5–20" },
        { value: "20-50", label: "20–50" }, { value: "50+", label: "50+" }] },
      { kind: "text", key: "company", label: "Компания (необязательно)", placeholder: "ООО «Пример»", target: "metadata" },
      { kind: "text", key: "city", label: "Город", required: true, placeholder: "Москва", target: "metadata" },
      { kind: "textarea", key: "message", label: "Комментарий (необязательно)", placeholder: "Сроки, требования, документы…" },
    ],
  },
  wholesale: {
    leadType: "wholesale",
    title: "Опт — запрос цены на партию",
    subtitle: "Укажите категорию и объём партии",
    cta: "Запросить оптовую цену",
    managerRole: "wholesale",
    intro: "Назовите категорию и объём партии — посчитаем оптовую цену.",
    closingHook: "Проверьте данные ниже и отправьте заявку — оптовый менеджер пришлёт "
      + "цену под партию.",
    fields: [
      { kind: "chips", key: "category", label: "Категория", required: true, options: [
        { value: "iphone", label: "iPhone", synonyms: ["айфон", "айфоны"] },
        { value: "macbook", label: "MacBook", synonyms: ["макбук", "макбуки"] },
        { value: "other_tech", label: "Другая техника", synonyms: ["прочая техника"] },
        { value: "accessories", label: "Аксессуары", synonyms: ["чехлы", "кабели"] },
        { value: "mixed", label: "Смешанная партия", synonyms: ["микс", "разное"] }] },
      { kind: "chips", key: "quantity_range", label: "Партия", required: true, options: [
        { value: "5-10", label: "5–10" }, { value: "10-30", label: "10–30" },
        { value: "30-100", label: "30–100" }, { value: "100+", label: "100+" }] },
      { kind: "text", key: "city", label: "Город", required: true, placeholder: "Казань", target: "metadata" },
      { kind: "text", key: "budget", label: "Ориентировочный бюджет (необязательно)", placeholder: "3 000 000 ₽", target: "metadata" },
      { kind: "textarea", key: "message", label: "Комментарий (необязательно)", placeholder: "Что важно по партии…" },
    ],
  },
};
```

`MACBOOK_CHOICES`, `buildScenarioLead`, `validateScenario`, `SCENARIO_ORIGIN`, `ScenarioLeadBody` — оставить без изменений (только что определённый выше блок целиком заменяет существующий `SCENARIOS`, остальной файл — как есть).

- [ ] **Step 4: Тесты проходят**

Run: `cd frontend && npx vitest run scenario.test.ts`
Expected: все PASS (старые + новые).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/scenario.ts frontend/src/lib/scenario.test.ts
git commit -m "feat(сценарии): синонимы chips + intro/closingHook для AI-чата"
```

---

## Task 10: `lib/scenarioChat.ts` — стейт-машин и локальный матчинг

**Files:**
- Create: `frontend/src/lib/scenarioChat.ts`
- Test: `frontend/src/lib/scenarioChat.test.ts`

**Interfaces:**
- Consumes: `Field`, `OptionItem`, `ScenarioConfig` из `./scenario`.
- Produces: `ChatStep` (тип), `stepsFor(cfg): ChatStep[]`, `matchChip(field, text): string | null`, `looksLikeQuestion(text): boolean`, `needsEscalation(field, text): boolean`, `isRequired(field): boolean`.

- [ ] **Step 1: Написать падающие тесты**

Создать `frontend/src/lib/scenarioChat.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./scenario";
import {
  isRequired, looksLikeQuestion, matchChip, needsEscalation, stepsFor,
} from "./scenarioChat";

describe("stepsFor", () => {
  it("все поля сценария + шаг телефона + шаг сводки, в этом порядке", () => {
    const steps = stepsFor(SCENARIOS.trade_in);
    expect(steps).toHaveLength(SCENARIOS.trade_in.fields.length + 2);
    expect(steps[steps.length - 2].kind).toBe("phone");
    expect(steps[steps.length - 1].kind).toBe("summary");
    expect(steps[0]).toMatchObject({ kind: "field", field: { key: "device_type" } });
  });
});

describe("matchChip", () => {
  const condition = SCENARIOS.trade_in.fields.find((f) => f.key === "condition")!;

  it("точное совпадение label", () => {
    expect(matchChip(condition, "Отличное")).toBe("excellent");
  });

  it("совпадение по синониму, регистр и пробелы не важны", () => {
    expect(matchChip(condition, "  ТРЕСНУЛ экран  ")).toBe("damaged");
  });

  it("не находит совпадение — null", () => {
    expect(matchChip(condition, "розовый в крапинку")).toBeNull();
  });

  it("для не-chips полей всегда null", () => {
    const model = SCENARIOS.trade_in.fields.find((f) => f.key === "model")!;
    expect(matchChip(model, "iPhone 15 Pro")).toBeNull();
  });
});

describe("looksLikeQuestion", () => {
  it("вопросительный знак", () => {
    expect(looksLikeQuestion("а сколько это будет стоить?")).toBe(true);
  });

  it("вопросительное слово без знака", () => {
    expect(looksLikeQuestion("сколько стоит оценка")).toBe(true);
  });

  it("обычный ответ — не вопрос", () => {
    expect(looksLikeQuestion("экран треснул")).toBe(false);
  });
});

describe("needsEscalation", () => {
  const condition = SCENARIOS.trade_in.fields.find((f) => f.key === "condition")!;
  const model = SCENARIOS.trade_in.fields.find((f) => f.key === "model")!;

  it("chips без локального совпадения -> true", () => {
    expect(needsEscalation(condition, "розовый в крапинку")).toBe(true);
  });

  it("chips с локальным совпадением -> false", () => {
    expect(needsEscalation(condition, "треснул")).toBe(false);
  });

  it("свободный текст без вопроса -> false (принимаем как есть)", () => {
    expect(needsEscalation(model, "iPhone 15 Pro")).toBe(false);
  });

  it("похоже на вопрос в любом поле -> true", () => {
    expect(needsEscalation(model, "а это точно нужно?")).toBe(true);
  });
});

describe("isRequired", () => {
  it("обязательное chips-поле", () => {
    const device = SCENARIOS.trade_in.fields.find((f) => f.key === "device_type")!;
    expect(isRequired(device)).toBe(true);
  });

  it("необязательное text-поле", () => {
    const memory = SCENARIOS.trade_in.fields.find((f) => f.key === "memory")!;
    expect(isRequired(memory)).toBe(false);
  });

  it("textarea всегда необязательна", () => {
    const comment = SCENARIOS.trade_in.fields.find((f) => f.key === "message")!;
    expect(isRequired(comment)).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd frontend && npx vitest run scenarioChat.test.ts`
Expected: FAIL — модуль `./scenarioChat` не найден.

- [ ] **Step 3: Реализовать**

Создать `frontend/src/lib/scenarioChat.ts`:

```typescript
/** Клиентский стейт-машин AI-чата сценарных заявок (Trade-In/бизнес/опт).
 *
 *  Чистые функции без DOM (vitest, node-окружение) — тот же приём, что у
 *  scenario.ts. Скрипт (не модель) решает, что показать следующим: тап по
 *  чипу или совпавший по синонимам свободный текст двигают диалог без сети.
 *  Эскалация к AI (POST /api/scenario-chat/turn) нужна только когда
 *  needsEscalation() вернула true — см. ScenarioChat.tsx.
 */
import type { Field, ScenarioConfig } from "./scenario";

export type ChatStep =
  | { kind: "field"; field: Field }
  | { kind: "phone" }
  | { kind: "summary" };

/** Шаги диалога: все поля сценария по порядку, затем телефон, затем сводка. */
export function stepsFor(cfg: ScenarioConfig): ChatStep[] {
  return [
    ...cfg.fields.map((field): ChatStep => ({ kind: "field", field })),
    { kind: "phone" },
    { kind: "summary" },
  ];
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Локальный матчинг свободного текста на chips-вариант: точный label или
 *  вхождение синонима. null для не-chips полей и при отсутствии совпадения —
 *  тогда решает needsEscalation, эскалировать ли к AI. */
export function matchChip(field: Field, text: string): string | null {
  if (field.kind !== "chips") return null;
  const norm = normalize(text);
  if (!norm) return null;
  for (const opt of field.options) {
    const candidates = [opt.label, ...(opt.synonyms ?? [])].map(normalize);
    if (candidates.some((c) => norm === c || norm.includes(c))) return opt.value;
  }
  return null;
}

// Вопросительный знак ИЛИ типичные вопросительные слова/обороты — намеренно
// широко: ошибка в эту сторону стоит один лишний вызов AI-эскалации, ошибка
// в другую — заявка молча уезжает с бессмысленным значением поля.
const QUESTION_RE = /\?|сколько|почему|зачем|а если|что если|можно ли|как долго|когда/iu;

export function looksLikeQuestion(text: string): boolean {
  return QUESTION_RE.test(text);
}

/** Нужна ли AI-эскалация: вопрос в любом поле, ИЛИ chips-поле без локального
 *  совпадения. Свободный текст без признаков вопроса принимается как есть —
 *  там и раньше не было валидации, кроме «не пусто» (ScenarioSheet). */
export function needsEscalation(field: Field, text: string): boolean {
  if (looksLikeQuestion(text)) return true;
  if (field.kind === "chips") return matchChip(field, text) === null;
  return false;
}

export function isRequired(field: Field): boolean {
  return "required" in field && field.required === true;
}
```

- [ ] **Step 4: Тесты проходят**

Run: `cd frontend && npx vitest run scenarioChat.test.ts`
Expected: все PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/scenarioChat.ts frontend/src/lib/scenarioChat.test.ts
git commit -m "feat(сценарии): клиентский стейт-машин и локальный матчинг AI-чата"
```

---

## Task 11: `lib/analytics.ts` — новые события

**Files:**
- Modify: `frontend/src/lib/analytics.ts`

- [ ] **Step 1: Добавить события в `AppEvent`**

В `frontend/src/lib/analytics.ts` заменить:

```typescript
  | "scenario_lead_failed"
  | "product_gallery_swiped"
```

на:

```typescript
  | "scenario_lead_failed"
  // v6: сценарный AI-чат вместо форм (/apply/<scenario>). opened — открытие
  // экрана; ai_escalated — шаг реально ушёл в модель (метрика того, что
  // скрипт держит нагрузку сам, не жжёт токены на каждую реплику).
  | "scenario_chat_opened"
  | "scenario_chat_ai_escalated"
  | "product_gallery_swiped"
```

Также добавить перед закрывающим `| "scenario_sheet_opened"` в комментарии пометку, что событие больше не отправляется (сам union не трогаем — старое имя должно остаться валидным на бэкенде для уже открытых вкладок со старым бандлом, тот же приём, что у `search_mode_switched`):

Заменить:
```typescript
  | "scenario_sheet_opened"
```
на:
```typescript
  // scenario_sheet_opened: форма (ScenarioRequestSheet) заменена AI-чатом
  // (scenario_chat_opened) — имя оставлено, чтобы старые вкладки не ловили 400.
  | "scenario_sheet_opened"
```

- [ ] **Step 2: Проверить компиляцию**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/analytics.ts
git commit -m "feat(аналитика): события scenario_chat_opened/scenario_chat_ai_escalated"
```

---

## Task 12: `components/ai/types.ts` — действие `scenario`

**Files:**
- Modify: `frontend/src/components/ai/types.ts`

- [ ] **Step 1: Расширить `AiAction`**

В `frontend/src/components/ai/types.ts` добавить импорт в начало файла (после существующего импорта `AvailabilityMode`):

```typescript
import type { ScenarioKey } from "../../lib/scenario";
```

Заменить:

```typescript
export type AiAction = {
  /** quick_reply — готовый ответ покупателя на уточняющий вопрос: нажатие
   *  отправляет label как обычное сообщение. Заменил кнопку "refine", которая
   *  только фокусировала поле ввода и выглядела бездействующей. */
  type: "compare" | "quick_reply" | "manager" | "lead";
  label: string;
  product_ids?: number[];
  product_id?: number;        // для type="lead": проверенный backend'ом товар
  manager_role?: ManagerRole; // для type="manager": какого менеджера открыть
};
```

на:

```typescript
export type AiAction = {
  /** quick_reply — готовый ответ покупателя на уточняющий вопрос: нажатие
   *  отправляет label как обычное сообщение. Заменил кнопку "refine", которая
   *  только фокусировала поле ввода и выглядела бездействующей.
   *  scenario — переход в AI-чат заявки (/apply/<scenario>): Trade-In/бизнес/
   *  опт формируются там, а не «Написать менеджеру». */
  type: "compare" | "quick_reply" | "manager" | "lead" | "scenario";
  label: string;
  product_ids?: number[];
  product_id?: number;        // для type="lead": проверенный backend'ом товар
  manager_role?: ManagerRole; // для type="manager": какого менеджера открыть
  scenario?: ScenarioKey;     // для type="scenario": куда вести
};
```

- [ ] **Step 2: Проверить компиляцию**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок (`AiSearch.tsx` пока не использует новый вариант — будет в Task 15).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ai/types.ts
git commit -m "feat(ai): тип действия scenario в AiAction"
```

---

## Task 13: Маршрут `/apply/:scenario`

**Files:**
- Modify: `frontend/src/lib/routePreload.ts`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `frontend/src/pages/ScenarioChat.tsx` (создаётся в Task 14 — этот таск можно выполнить раньше, `import()` не проверяется до сборки, но реальный экран появится только в Task 14; после Task 13 без Task 14 `npm run build` упадёт на отсутствующем файле — поэтому Task 13 и Task 14 коммитятся вместе одним коммитом на шаге 14.5, до этого — не пушить/не собирать).

- [ ] **Step 1: Зарегистрировать загрузчик**

В `frontend/src/lib/routePreload.ts` заменить:

```typescript
export const routeLoaders = {
  catalog: withStaleChunkReload(() => import("../pages/Catalog")),
  product: withStaleChunkReload(() => import("../pages/ProductDetails")),
  ai: withStaleChunkReload(() => import("../pages/AiSearch")),
  requests: withStaleChunkReload(() => import("../pages/Requests")),
  cart: withStaleChunkReload(() => import("../pages/Cart")),
  favorites: withStaleChunkReload(() => import("../pages/Favorites")),
  history: withStaleChunkReload(() => import("../pages/History")),
  profile: withStaleChunkReload(() => import("../pages/Profile")),
  loyalty: withStaleChunkReload(() => import("../pages/Loyalty")),
  info: withStaleChunkReload(() => import("../pages/Info")),
};
```

на:

```typescript
export const routeLoaders = {
  catalog: withStaleChunkReload(() => import("../pages/Catalog")),
  product: withStaleChunkReload(() => import("../pages/ProductDetails")),
  ai: withStaleChunkReload(() => import("../pages/AiSearch")),
  requests: withStaleChunkReload(() => import("../pages/Requests")),
  cart: withStaleChunkReload(() => import("../pages/Cart")),
  favorites: withStaleChunkReload(() => import("../pages/Favorites")),
  history: withStaleChunkReload(() => import("../pages/History")),
  profile: withStaleChunkReload(() => import("../pages/Profile")),
  loyalty: withStaleChunkReload(() => import("../pages/Loyalty")),
  info: withStaleChunkReload(() => import("../pages/Info")),
  scenarioChat: withStaleChunkReload(() => import("../pages/ScenarioChat")),
};
```

И добавить в `routeKey()` перед `return null;`:

```typescript
  if (pathname.startsWith("/apply/")) return "scenarioChat";
```

- [ ] **Step 2: Зарегистрировать маршрут**

В `frontend/src/App.tsx` добавить импорт после `const AiSearch = lazy(routeLoaders.ai);`:

```typescript
const ScenarioChat = lazy(routeLoaders.scenarioChat);
```

Добавить `<Route>` после `<Route path="/ai" element={<DeferredPage><AiSearch /></DeferredPage>} />`:

```tsx
<Route path="/apply/:scenario" element={<DeferredPage><ScenarioChat /></DeferredPage>} />
```

- [ ] **Step 3: Commit отложить**

Не коммитить отдельно — `import("../pages/ScenarioChat")` ссылается на файл, которого ещё нет. Коммит — в конце Task 14 (Step 8), одним коммитом с самим экраном.

---

## Task 14: `pages/ScenarioChat.tsx` — экран AI-чата заявки

**Files:**
- Create: `frontend/src/pages/ScenarioChat.tsx`

**Interfaces:**
- Consumes: `SCENARIOS`, `buildScenarioLead`, `ScenarioKey` (`lib/scenario.ts`); `stepsFor`, `matchChip`, `needsEscalation`, `isRequired`, `ChatStep` (`lib/scenarioChat.ts`); `leadMetadataRows` (`lib/leads.ts`); `api` (`lib/api.ts`); `track` (`lib/analytics.ts`); `haptic`, `openExternalLink` (`lib/telegram.ts`); `usePublicConfig` (`lib/appConfig.ts`); `useAuthStore` (`store/auth.ts`); `Icon` (`components/icons.tsx`).

- [ ] **Step 1: Создать компонент**

Создать `frontend/src/pages/ScenarioChat.tsx`:

```tsx
/** AI-чат сценарной заявки (Trade-In / Для бизнеса / Опт) — v6.
 *
 *  Заменяет статичный bottom-sheet (ScenarioSheet.ScenarioRequestSheet).
 *  Скрипт (scenarioChat.ts) ведёт диалог по шагам БЕЗ модели: тап по чипу
 *  или совпавший по синонимам текст двигают state без сети. AI подключается
 *  только когда needsEscalation() вернула true — см.
 *  docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md.
 *
 *  Контракт отправки — тот же POST /leads с lead_type/metadata, что и у
 *  прежней формы: админка и лента заявок не меняются.
 */
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { leadMetadataRows } from "../lib/leads";
import {
  SCENARIOS, buildScenarioLead, type Field, type OptionItem, type ScenarioKey,
} from "../lib/scenario";
import {
  isRequired, matchChip, needsEscalation, stepsFor, type ChatStep,
} from "../lib/scenarioChat";
import { haptic, openExternalLink } from "../lib/telegram";
import { usePublicConfig } from "../lib/appConfig";
import { useAuthStore } from "../store/auth";
import { Icon } from "../components/icons";

type ChatMsg = { role: "user" | "assistant"; text: string };
type TurnResponse = { type: string; value: string | null; reply: string | null };

function isScenarioKey(v: string | undefined): v is ScenarioKey {
  return !!v && v in SCENARIOS;
}

export default function ScenarioChat() {
  const params = useParams<{ scenario: string }>();
  if (!isScenarioKey(params.scenario)) return <Navigate to="/" replace />;
  return <ScenarioChatScreen scenario={params.scenario} />;
}

function ScenarioChatScreen({ scenario }: { scenario: ScenarioKey }) {
  const cfg = SCENARIOS[scenario];
  const navigate = useNavigate();
  const config = usePublicConfig();
  const user = useAuthStore((s) => s.user);
  const requirePhone = !user?.username;
  const managerUrl = (scenario === "trade_in" ? config.manager_tradein_url
    : scenario === "b2b" ? config.manager_b2b_url
    : config.manager_wholesale_url) || config.manager_retail_url;

  const steps = useRef<ChatStep[]>(stepsFor(cfg)).current;
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([{ role: "assistant", text: cfg.intro }]);
  const [inputValue, setInputValue] = useState("");
  const [pending, setPending] = useState(false);
  const [sendState, setSendState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const currentStep = steps[stepIndex];
  const endRef = useRef<HTMLDivElement>(null);
  const pushedStepRef = useRef(-1);

  useEffect(() => { track("scenario_chat_opened", { scenario }); }, [scenario]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, pending]);

  function pushAssistant(text: string) { setMessages((m) => [...m, { role: "assistant", text }]); }
  function pushUser(text: string) { setMessages((m) => [...m, { role: "user", text }]); }

  // Реплика-вопрос для текущего шага — ровно один раз при входе на шаг.
  useEffect(() => {
    if (pushedStepRef.current === stepIndex) return;
    pushedStepRef.current = stepIndex;
    const step = steps[stepIndex];
    if (step.kind === "field") {
      pushAssistant(step.field.label.replace(/\s*\(необязательно\)$/, ""));
    } else if (step.kind === "phone") {
      pushAssistant(requirePhone
        ? "Оставьте телефон для связи"
        : "Телефон для связи (необязательно — вам смогут написать в Telegram)");
    } else {
      pushAssistant(cfg.closingHook);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  function resolveField(field: Field, value: string) {
    setValues((v) => ({ ...v, [field.key]: value }));
    haptic("light");
    track("scenario_option_selected", { scenario, field: field.key });
    setStepIndex((i) => i + 1);
  }

  function pickChip(field: Field, opt: OptionItem) {
    pushUser(opt.label);
    resolveField(field, opt.value);
  }

  function skipField(field: Field) {
    pushUser("Пропущено");
    setInputValue("");
    haptic("light");
    setStepIndex((i) => i + 1);
  }

  async function escalate(field: Field, text: string) {
    setPending(true);
    track("scenario_chat_ai_escalated", { scenario, field: field.key });
    const options = field.kind === "chips"
      ? field.options.map((o) => ({ value: o.value, label: o.label })) : [];
    try {
      const res = await api<TurnResponse>("/scenario-chat/turn", {
        method: "POST",
        body: JSON.stringify({ scenario, field_key: field.key, options, message: text.slice(0, 500) }),
      });
      if (res.type === "field_value" && res.value && options.some((o) => o.value === res.value)) {
        resolveField(field, res.value);
        return;
      }
      if (res.type === "answer_question" && res.reply) {
        pushAssistant(res.reply);
        return;
      }
      pushAssistant(res.reply || "Не расслышал — выберите один из вариантов ниже или уточните ответ.");
    } catch {
      pushAssistant("Не расслышал — выберите один из вариантов ниже или уточните ответ.");
    } finally {
      setPending(false);
    }
  }

  async function handleFieldSubmit(field: Field, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    pushUser(trimmed);
    setInputValue("");

    if (field.kind === "chips") {
      const matched = matchChip(field, trimmed);
      if (matched !== null) { resolveField(field, matched); return; }
    }
    if (needsEscalation(field, trimmed)) { await escalate(field, trimmed); return; }
    resolveField(field, trimmed);
  }

  function handlePhoneSubmit(text: string) {
    const trimmed = text.trim();
    if (requirePhone && !trimmed) {
      pushAssistant("Без телефона менеджеру не с кем связаться — укажите номер, пожалуйста.");
      haptic("rigid");
      return;
    }
    pushUser(trimmed || "Без телефона — свяжутся в Telegram");
    setPhone(trimmed);
    setInputValue("");
    setStepIndex((i) => i + 1);
  }

  async function submitLead() {
    if (sendState === "sending") return;
    setSendState("sending");
    setError("");
    haptic("medium");
    track("scenario_lead_submitted", { scenario, source: "home" });
    try {
      await api("/leads", { method: "POST", body: JSON.stringify(buildScenarioLead(scenario, values, phone)) });
      track("scenario_lead_success", { scenario });
      haptic("light");
      setSendState("done");
    } catch (e) {
      track("scenario_lead_failed", { scenario });
      setError(e instanceof Error ? e.message : "Не удалось отправить заявку");
      setSendState("error");
    }
  }

  if (sendState === "done") {
    return (
      <div className="mx-auto max-w-md px-4 py-10 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green/15 text-green">
          <Icon name="check" className="h-8 w-8" strokeWidth={2.2} />
        </div>
        <p className="mt-4 text-lg font-bold">Заявка отправлена</p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-muted">
          Менеджер изучит информацию и свяжется с вами в Telegram. Статус можно посмотреть в разделе «Заявки».
        </p>
        <button
          onClick={() => navigate("/requests")}
          className="tap mt-5 w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white"
        >
          Посмотреть заявку
        </button>
        {managerUrl && managerUrl.trim() && (
          <button
            onClick={() => openExternalLink(managerUrl)}
            className="tap mt-2 w-full rounded-xl2 bg-mutedbg py-3 text-sm font-semibold text-text"
          >
            Написать менеджеру сейчас
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md pb-cta">
      <div className="flex items-center gap-3 px-4 pt-4">
        <button onClick={() => navigate("/")} aria-label="Назад" className="tap flex h-9 w-9 items-center justify-center rounded-full bg-surface shadow-soft">
          <Icon name="close" className="h-4 w-4" strokeWidth={2} />
        </button>
        <h1 className="text-lg font-bold">{cfg.title}</h1>
      </div>

      <div className="mt-4 space-y-3 px-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={
              m.role === "user"
                ? "max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white"
                : "max-w-[92%] rounded-2xl rounded-bl-md bg-surface px-4 py-3 text-sm shadow-soft"
            }>
              {m.text}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex w-fit max-w-[92%] items-center gap-1.5 rounded-2xl rounded-bl-md bg-surface px-4 py-3.5 shadow-soft">
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Чипы текущего шага — видны, пока шаг не пройден, независимо от истории сообщений */}
      {!pending && currentStep.kind === "field" && currentStep.field.kind === "chips" && (
        <div className="mt-3 flex flex-wrap gap-2 px-4">
          {currentStep.field.options.map((opt) => (
            <button
              key={opt.value} onClick={() => pickChip(currentStep.field as Field, opt)}
              className="tap rounded-full border border-border bg-surface px-4 py-2 text-[13px] font-semibold text-text transition-colors hover:border-accent"
            >
              {opt.label}
            </button>
          ))}
          {!isRequired(currentStep.field) && (
            <button
              onClick={() => skipField(currentStep.field as Field)}
              className="tap rounded-full px-3 py-2 text-[13px] font-medium text-muted underline-offset-2 hover:underline"
            >
              Пропустить
            </button>
          )}
        </div>
      )}

      {currentStep.kind === "summary" && (
        <div className="mt-3 space-y-3 px-4">
          <div className="rounded-xl2 bg-surface p-4 shadow-soft">
            {leadMetadataRows(buildScenarioLead(scenario, values, phone).metadata).map((row) => (
              <div key={row.label} className="flex justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0">
                <span className="text-muted">{row.label}</span>
                <span className="text-right font-medium">{row.value}</span>
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            onClick={submitLead} disabled={sendState === "sending"}
            className="tap w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white disabled:opacity-50"
          >
            {sendState === "sending" ? "Отправляем…" : cfg.cta}
          </button>
        </div>
      )}

      {((currentStep.kind === "field" && currentStep.field.kind !== "chips") || currentStep.kind === "phone") && (
        <div className="mt-3 flex gap-2 px-4">
          <input
            value={inputValue} onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (currentStep.kind === "phone") handlePhoneSubmit(inputValue);
              else if (currentStep.kind === "field") void handleFieldSubmit(currentStep.field, inputValue);
            }}
            inputMode={currentStep.kind === "phone" ? "tel" : "text"}
            placeholder={currentStep.kind === "phone" ? "+7 900 000-00-00" : "Введите ответ…"}
            maxLength={currentStep.kind === "phone" ? 64 : 500}
            disabled={pending}
            className="min-w-0 flex-1 rounded-xl2 bg-surface px-4 py-3.5 text-sm shadow-soft outline-none placeholder:text-muted disabled:opacity-50"
          />
          {currentStep.kind === "phone" && !requirePhone && (
            <button
              onClick={() => handlePhoneSubmit("")} disabled={pending}
              className="tap shrink-0 rounded-xl2 bg-mutedbg px-4 text-sm font-semibold text-text disabled:opacity-50"
            >
              Пропустить
            </button>
          )}
          <button
            onClick={() => {
              if (currentStep.kind === "phone") handlePhoneSubmit(inputValue);
              else if (currentStep.kind === "field") void handleFieldSubmit(currentStep.field, inputValue);
            }}
            disabled={pending || (currentStep.kind === "field" && !inputValue.trim() && isRequired(currentStep.field))}
            className="tap flex h-12 w-12 shrink-0 items-center justify-center rounded-xl2 bg-accent text-white shadow-soft disabled:opacity-40"
            aria-label="Отправить"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок. Если `Icon`/`haptic`/`openExternalLink`/`usePublicConfig`/`useAuthStore` дают ошибку импорта — свериться с точными путями в `frontend/src/pages/Home.tsx` (те же самые модули уже импортируются там) и поправить относительные пути под расположение `pages/ScenarioChat.tsx`.

- [ ] **Step 3: Собрать фронтенд**

Run: `cd frontend && npm run build`
Expected: сборка проходит без ошибок (маршрут из Task 13 теперь резолвится).

- [ ] **Step 4: Запустить дев-стенд и проверить happy path в браузере**

```bash
docker compose -f docker-compose.demo.yml up -d --build frontend
```

Открыть `http://localhost:5173/apply/trade_in` (после логина в приложении — экран требует авторизованного пользователя, как и остальные разделы). Проверить:
- интро + первый вопрос появляются как бабблы;
- тап по чипу продвигает диалог, каждый последующий вопрос — новый баббл;
- на поле `condition` ввести текст «экран треснул» вместо тапа — должен смэтчиться локально на «Есть повреждения» без задержки (без реального вызова AI, т.к. `AI_PROVIDER=fallback` по умолчанию — если тем не менее матчинг не сработал, экран корректно уходит в `pending` → эскалацию → получает `unclear` от backend (Task 4 гарантирует это без ключа) → показывает нейтральную фразу и НЕ блокирует ввод);
- ввести в любое поле текст с `?` — должен уйти в эскалацию и вернуться с `unclear` (т.к. локально `AI_PROVIDER=fallback`), диалог не должен зависнуть или упасть;
- необязательные поля — кнопка «Пропустить» продвигает шаг;
- шаг телефона — обязательность зависит от наличия `@username` у тестового пользователя;
- сводка показывает те же подписи, что и раньше в форме (та же `leadMetadataRows`, что использует `/requests`);
- «Отправить заявку» создаёт lead, экран успеха показывает «Посмотреть заявку» → `/requests` содержит новую заявку с правильным типом.

Повторить для `/apply/b2b` и `/apply/wholesale`.

- [ ] **Step 5: Commit (вместе с маршрутом из Task 13)**

```bash
git add frontend/src/pages/ScenarioChat.tsx frontend/src/lib/routePreload.ts frontend/src/App.tsx
git commit -m "feat(сценарии): экран AI-чата заявки (/apply/:scenario)"
```

---

## Task 15: `pages/AiSearch.tsx` — переход по действию `scenario`

**Files:**
- Modify: `frontend/src/pages/AiSearch.tsx`

- [ ] **Step 1: Добавить ветку в `handleAction`**

В `frontend/src/pages/AiSearch.tsx` заменить:

```typescript
  function handleAction(action: AiAction, answer: AiAnswer) {
    if (action.type === "quick_reply") {
      // Нажатие = обычное сообщение от покупателя: диалог продолжается без
      // печати, и модель видит ровно тот текст, который написан на кнопке.
      void submit(action.label);
      return;
    }
    if (action.type === "manager") {
```

на:

```typescript
  function handleAction(action: AiAction, answer: AiAnswer) {
    if (action.type === "quick_reply") {
      // Нажатие = обычное сообщение от покупателя: диалог продолжается без
      // печати, и модель видит ровно тот текст, который написан на кнопке.
      void submit(action.label);
      return;
    }
    if (action.type === "scenario" && action.scenario) {
      navigate(`/apply/${action.scenario}`);
      return;
    }
    if (action.type === "manager") {
```

`navigate` уже импортирован и используется в этом компоненте (`const navigate = useNavigate();`) — дополнительных импортов не требуется.

- [ ] **Step 2: Проверить типы**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 3: Ручная проверка в браузере**

На дев-стенде открыть `/ai`, написать «хочу оптом партию ноутбуков» — детерминированная ветка `ai_orchestrator.py` (Task 7) должна вернуть ответ с двумя кнопками: «Оставить оптовую заявку» (primary) и «Оптовый менеджер». Клик по первой — переход на `/apply/wholesale` с уже пройденным интро.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/AiSearch.tsx
git commit -m "feat(ai): переход в AI-чат заявки по действию scenario из /ai"
```

---

## Task 16: `pages/Home.tsx` — точки входа ведут в AI-чат

**Files:**
- Modify: `frontend/src/pages/Home.tsx`

- [ ] **Step 1: Заменить открытие sheet на навигацию**

В `frontend/src/pages/Home.tsx` заменить:

```typescript
  // v5.4.0: встроенные сценарные заявки (Trade-In/бизнес/опт) и меню MacBook.
  const [scenario, setScenario] = useState<ScenarioKey | null>(null);
  const [macbookOpen, setMacbookOpen] = useState(false);
  // Контакт обязателен, только если менеджеру некуда ответить в Telegram
  // (у пользователя нет @username) — тогда просим телефон.
  const requirePhone = !user?.username;
  const managerUrlFor = (k: ScenarioKey): string =>
    (k === "trade_in" ? config.manager_tradein_url
      : k === "b2b" ? config.manager_b2b_url
      : config.manager_wholesale_url) || config.manager_retail_url;

  function openScenario(k: ScenarioKey) {
    track("quick_scenario_clicked", { scenario: k });
    setScenario(k);
  }
```

на:

```typescript
  // v6: Trade-In/бизнес/опт ведут в AI-чат заявки (/apply/:scenario) вместо
  // встроенного bottom-sheet. Меню MacBook (v5.4.0) остаётся как есть — это
  // prefill в /ai, не lead-сценарий.
  const [macbookOpen, setMacbookOpen] = useState(false);

  function openScenario(k: ScenarioKey) {
    track("quick_scenario_clicked", { scenario: k });
    navigate(`/apply/${k}`);
  }
```

- [ ] **Step 2: Убрать использование `ScenarioRequestSheet`**

Заменить:

```tsx
      {/* v5.4.0: встроенные сценарные заявки (Trade-In / Для бизнеса / Опт) */}
      {scenario && (
        <ScenarioRequestSheet
          scenario={scenario}
          managerUrl={managerUrlFor(scenario)}
          requirePhone={requirePhone}
          onClose={() => setScenario(null)}
        />
      )}
      {/* v5.4.0: меню «Подобрать MacBook» (AI prefill, без заявки и авто-отправки) */}
```

на:

```tsx
      {/* v5.4.0: меню «Подобрать MacBook» (AI prefill, без заявки и авто-отправки) */}
```

- [ ] **Step 3: Убрать теперь неиспользуемый импорт**

Заменить:

```typescript
import { ScenarioRequestSheet, ScenarioChoiceSheet } from "../components/ScenarioSheet";
```

на:

```typescript
import { ScenarioChoiceSheet } from "../components/ScenarioSheet";
```

- [ ] **Step 4: Проверить, что `user` всё ещё используется в файле**

`const user = useAuthStore((s) => s.user);` мог остаться нужен для других частей `Home.tsx` (проверить `grep -n "user\." frontend/src/pages/Home.tsx` или `grep -n "\buser\b" frontend/src/pages/Home.tsx`). Если после удаления `requirePhone` переменная `user` больше нигде не используется — удалить и её объявление; если используется (например, в приветствии/профиле на главной) — оставить как есть.

- [ ] **Step 5: Проверить типы**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок, без предупреждений о неиспользуемых импортах/переменных (в `tsconfig.json` `noUnusedLocals` не включён, поэтому `tsc` их не поймает — проверить глазами: `grep -n "ScenarioKey\|requirePhone\|managerUrlFor" frontend/src/pages/Home.tsx` не должен находить мёртвых остатков).

- [ ] **Step 6: Ручная проверка в браузере**

На главной странице (mobile: три плитки «Trade-In / Бизнесу / Опт»; desktop: сайдбар «Быстрые действия») клик по каждой должен вести на `/apply/trade_in`, `/apply/b2b`, `/apply/wholesale` соответственно — не открывать больше bottom-sheet.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Home.tsx
git commit -m "feat(главная): Trade-In/бизнес/опт открывают AI-чат вместо формы"
```

---

## Task 17: `components/ScenarioSheet.tsx` — удалить `ScenarioRequestSheet`

**Files:**
- Modify: `frontend/src/components/ScenarioSheet.tsx`

- [ ] **Step 1: Убедиться, что `ScenarioRequestSheet` больше нигде не импортируется**

Run: `cd frontend && grep -rn "ScenarioRequestSheet" src`
Expected: ноль совпадений вне `ScenarioSheet.tsx` (Task 16 уже убрал единственного потребителя).

- [ ] **Step 2: Удалить компонент и обновить шапку файла**

В `frontend/src/components/ScenarioSheet.tsx` заменить блок doc-комментария в начале файла:

```typescript
/** Встроенные сценарные заявки (v5.4.0).
 *
 *  ScenarioRequestSheet — один конфигурируемый bottom-sheet (mobile) / центр-модалка
 *  (desktop) для Trade-In / «Для бизнеса» / «Опт». Создаёт структурированную заявку
 *  (POST /leads с lead_type + metadata) прямо в приложении, без ухода к менеджеру.
 *  ScenarioChoiceSheet — лёгкое меню выбора (для «Подобрать MacBook»): только
 *  навигация в AI с prefill, БЕЗ создания заявки и без авто-отправки.
 *
 *  Рендер через portal в document.body (как LeadForm): fixed-оверлей позиционируется
 *  от viewport и не зависит от transform/overflow родителей. Управление фокусом,
 *  блокировка фонового скролла, Escape, safe-area, haptic, защита от двойной отправки.
 */
```

на:

```typescript
/** Общий шелл шторки (SheetShell) + ScenarioChoiceSheet (v5.4.0, v6).
 *
 *  Форма сценарных заявок (Trade-In/бизнес/опт) заменена AI-чатом
 *  (pages/ScenarioChat.tsx, /apply/:scenario) — см.
 *  docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md.
 *  ScenarioChoiceSheet — лёгкое меню выбора (для «Подобрать MacBook»): только
 *  навигация в AI с prefill, БЕЗ создания заявки и без авто-отправки.
 *
 *  SheetShell — общая оболочка (portal, backdrop, Escape, scroll-lock, focus
 *  trap), переиспользуется AiRoadmapSheet/LoyaltyRoadmapSheet — не удалять.
 */
```

Удалить весь блок `ScenarioRequestSheet` — от строки-комментария
```typescript
/* ============================================================
   ScenarioRequestSheet — форма сценария и success-state.
   ============================================================ */
export function ScenarioRequestSheet({
```
до закрывающей `}` этой функции (перед комментарием `/* ============================================================\n   ScenarioChoiceSheet — меню «Какой MacBook вам нужен?».`).

- [ ] **Step 3: Убрать неиспользуемые импорты**

После удаления проверить, какие из текущих импортов файла (`useNavigate`, `api`, `buildScenarioLead`, `validateScenario`) больше не используются в оставшемся коде (`SheetShell`, `DragHandle`, `CloseButton`, `ScenarioChoiceSheet`). `ScenarioChoiceSheet` не создаёт заявок и не ходит в API — вероятно, все четыре станут неиспользуемыми. Заменить блок импортов:

```typescript
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { haptic, openExternalLink } from "../lib/telegram";
import { transitionDuration } from "../lib/motion";
import {
  SCENARIOS,
  buildScenarioLead,
  validateScenario,
  type ChoiceItem,
  type Field,
  type ScenarioKey,
} from "../lib/scenario";
import { Icon } from "./icons";
```

на (оставить только реально используемое оставшимся кодом — свериться по факту через `grep -n "haptic\|track\|useNavigate\|api(" frontend/src/components/ScenarioSheet.tsx` после удаления Step 2, `ScenarioChoiceSheet` использует `haptic` при клике на пункт меню):

```typescript
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { haptic } from "../lib/telegram";
import { transitionDuration } from "../lib/motion";
import type { ChoiceItem } from "../lib/scenario";
import { Icon } from "./icons";
```

Оставить экспорт `export type { ScenarioKey, ChoiceItem } from "../lib/scenario";` как есть — `ScenarioChat.tsx` (Task 14) импортирует `ScenarioKey` напрямую из `lib/scenario`, но другой код в проекте может ещё опираться на реэкспорт из `ScenarioSheet` (проверить: `grep -rn "from \"../components/ScenarioSheet\"" frontend/src` и `grep -rn "from \"./components/ScenarioSheet\"" frontend/src` — если реэкспорт `ScenarioKey`/`ChoiceItem` используется, не удалять).

- [ ] **Step 4: Проверить типы и сборку**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: без ошибок.

- [ ] **Step 5: Прогнать frontend-тесты**

Run: `cd frontend && npx vitest run`
Expected: все PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ScenarioSheet.tsx
git commit -m "refactor(сценарии): удалить ScenarioRequestSheet — заменена AI-чатом"
```

---

## Task 18: Финальная проверка

**Files:** нет изменений — только верификация.

- [ ] **Step 1: Полный backend-прогон**

Run: `cd backend && python -m pytest -q`
Expected: все тесты проходят, включая `test_event_allowlist_sync.py` (события Task 5/11 теперь синхронизированы на обеих сторонах).

- [ ] **Step 2: Полный frontend-прогон**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: без ошибок типов, все тесты PASS, сборка проходит.

- [ ] **Step 3: Admin — убедиться, что ничего не задето**

Run: `cd admin && npx tsc --noEmit && npm run build`
Expected: без ошибок (контракт `Lead`/`metadata` не менялся — `admin/src/ui.ts` не трогали ни в одном таске).

- [ ] **Step 4: Сквозная ручная проверка в браузере (дев-стенд)**

На `docker-compose.demo.yml` (`AI_PROVIDER=fallback` по умолчанию — эскалация к реальной модели не проверяется без ключа, но обязана деградировать в `unclear`, не падать):

1. С Главной — все три точки входа (`Trade-In`, `Бизнесу`, `Опт`, mobile-плитки и desktop-сайдбар) открывают `/apply/<scenario>`, не bottom-sheet.
2. Полный проход одного сценария от интро до «Заявка отправлена», заявка появляется в `/requests` с верным заголовком (`leadTitle`) и полями.
3. В `/ai` — фраза, детерминированно триггерящая `wholesale`/`b2b`/`trade_in` (см. Task 7), даёт кнопку «Оформить...»/«Оставить заявку» первой; клик ведёт на `/apply/<scenario>`.
4. В любом chips-шаге ввести текст, не совпадающий ни с одной подсказкой (например, случайный набор слов) — экран уходит в `pending`, затем показывает нейтральную фразу и НЕ ломается (backend возвращает `unclear`, т.к. локально нет ключа Anthropic).
5. `/apply/unknown_scenario` (руками в адресной строке) — редиректит на `/`.

- [ ] **Step 5: Итоговый коммит (если после ручной проверки были правки)**

Если Step 4 выявил и потребовал точечных правок — закоммитить их отдельным коммитом с понятным сообщением перед тем, как считать патч завершённым. Если правок не было — этот шаг пропускается, финальный коммит уже сделан в Task 17.
