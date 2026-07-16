"""Оркестратор локального AI-консультанта (v5).

Пайплайн: deterministic intents -> извлечение фильтров -> retrieval (только БД)
-> AI Gateway (Mac mini/Ollama) -> строгая валидация structured output ->
карточки/цены ТОЛЬКО из БД -> при любой ошибке существующий fallback.

Инварианты:
- LLM видит максимум AI_MAX_PRODUCT_CANDIDATES кандидатов, выбранных backend'ом;
- recommended_product_ids вне списка кандидатов молча отбрасываются;
- пользователь никогда не получает сырой JSON, stack trace, IP или имя модели.
"""
import logging
import re
import time
import unicodedata
from functools import lru_cache
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.product import Product
from app.services.ai_provider import build_demo_answer
from app.services.ai_remote import AIGatewayError, call_gateway
from app.services.ai_retrieval import candidate_payload, extract_filters, retrieve_candidates
from app.services.ai_schemas import AiAnswerParseError, AiStructuredAnswer, parse_structured_answer

logger = logging.getLogger("techshop.ai.orchestrator")

_PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"


@lru_cache(maxsize=4)
def load_system_prompt(version: str) -> str:
    path = _PROMPTS_DIR / f"ai_seller_system_{version}.md"
    return path.read_text(encoding="utf-8")


# ---------- deterministic intents: без LLM (экономим Mac mini, отвечаем мгновенно) ----------

_DETERMINISTIC = [
    # (intent, ключевые фразы, ответ, action-кнопки)
    ("manager", ("контакт", "менеджер", "связаться", "позвонить", "написать человеку"),
     "Соединю с менеджером — он ответит на вопросы по товарам, оплате и доставке.",
     [{"type": "manager", "label": "Написать менеджеру"}]),
    ("wholesale", ("опт", "оптом", "партию", "партия от"),
     "Работаем с оптовыми закупками: партии от 5 штук, специальные цены. Оставьте контакт менеджеру по опту.",
     [{"type": "manager", "label": "Оптовый менеджер"}]),
    ("b2b", ("b2b", "для компании", "юрлиц", "юр лиц", "счёт для организации", "поставка в офис"),
     "Поставляем технику компаниям: документы для юрлиц, безнал, закрывающие. Менеджер расскажет условия.",
     [{"type": "manager", "label": "B2B-менеджер"}]),
    ("trade_in", ("trade-in", "trade in", "трейд-ин", "трейдин", "обмен старого", "выкуп"),
     "Trade-In: примем вашу текущую технику в зачёт новой или выкупим. Оценку сделает менеджер.",
     [{"type": "manager", "label": "Оценить устройство"}]),
]

_ABOUT_RE = re.compile(
    r"^(ты\s+(ии|ai|бот|робот)|кто\s+ты|что\s+ты\s+(умеешь|можешь)|как\s+ты\s+работаешь|привет|здравствуй)",
    re.IGNORECASE,
)

_ABOUT_ANSWER = (
    "Я AI-консультант магазина AI Seller. Помогаю подобрать технику под задачу и бюджет: "
    "смартфоны, ноутбуки, планшеты, наушники, консоли. Опишите, что ищете — например, "
    "«ноутбук до 150 тысяч для монтажа» — и я предложу варианты из наличия с честными компромиссами."
)


def _deterministic_answer(message: str) -> dict | None:
    low = message.lower().strip()
    if _ABOUT_RE.search(low):
        return {
            "text": _ABOUT_ANSWER, "cards": [],
            "actions": [{"type": "refine", "label": "Подобрать технику"}],
            "meta": {"source": "rules", "intent": "general_help"},
        }
    for intent, keywords, answer, actions in _DETERMINISTIC:
        if any(k in low for k in keywords):
            return {"text": answer, "cards": [], "actions": actions,
                    "meta": {"source": "rules", "intent": intent}}
    return None


# ---------- санитизация недоверенного ввода ----------

_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _sanitize(text: str, max_len: int = 1000) -> str:
    text = unicodedata.normalize("NFC", text or "")
    return _CTRL_RE.sub(" ", text)[:max_len].strip()


def _sanitize_history(history: list[dict]) -> list[dict]:
    limit = max(0, int(settings.AI_MAX_HISTORY_MESSAGES))
    out = []
    for item in history[-limit:]:
        role = "assistant" if str(item.get("role")) == "assistant" else "user"
        text = _sanitize(str(item.get("text", "")))
        if text:
            out.append({"role": role, "text": text})
    return out


# ---------- основной вход ----------

async def answer_via_local_ai(db: Session, message: str, history: list[dict]) -> dict:
    """Полный пайплайн. Всегда возвращает контракт {text, cards, actions, meta}."""
    t0 = time.monotonic()
    message = _sanitize(message)
    history = _sanitize_history(history)

    # 0) простые интенты — мгновенно и бесплатно
    det = _deterministic_answer(message)
    if det is not None:
        det["meta"]["latency_ms"] = int((time.monotonic() - t0) * 1000)
        return det

    # 1) фильтры + retrieval (только наша БД)
    user_history_texts = [h["text"] for h in history if h["role"] == "user"]
    filters = extract_filters(message, user_history_texts)
    candidates = retrieve_candidates(db, message, filters, limit=max(1, settings.AI_MAX_PRODUCT_CANDIDATES))
    retrieval_ms = int((time.monotonic() - t0) * 1000)

    # 2) LLM через Gateway
    try:
        system = load_system_prompt(settings.AI_SYSTEM_PROMPT_VERSION)
        payload_history = [{"role": h["role"], "content": h["text"]} for h in history]
        gw = await call_gateway(
            system=system, message=message,
            history=payload_history, candidates=candidate_payload(candidates),
        )
        structured = parse_structured_answer(gw["content"])
    except (AIGatewayError, AiAnswerParseError, OSError) as e:
        if not settings.AI_FALLBACK_ENABLED:
            raise
        logger.warning("Local AI degraded to fallback: %s", type(e).__name__)
        answer = build_demo_answer(db, message, source="fallback")
        answer["meta"].update({
            "degraded": True, "retrieval_ms": retrieval_ms,
            "fallback_reason": type(e).__name__,
        })
        # нейтральное уведомление, без технических деталей
        answer["text"] = "Сейчас отвечаю в упрощённом режиме, но могу подобрать варианты из каталога. " + answer["text"]
        return answer

    # 3) валидация product_id: строго подмножество кандидатов
    allowed = {p.id: p for p in candidates}
    valid_ids = [pid for pid in structured.recommended_product_ids if pid in allowed]
    dropped = len(structured.recommended_product_ids) - len(valid_ids)
    if dropped:
        logger.warning("LLM suggested %d unknown product ids — dropped", dropped)
    products: list[Product] = [allowed[pid] for pid in valid_ids[:3]]

    # 4) текст пользователю: ответ + один уточняющий вопрос (если есть)
    text = structured.answer.strip()
    if structured.follow_up_question:
        text = f"{text}\n\n{structured.follow_up_question.strip()}"

    actions = [{"type": "refine", "label": "Уточнить запрос"}]
    if structured.next_action == "open_manager" or structured.intent in ("wholesale", "b2b", "trade_in", "manager"):
        actions.append({"type": "manager", "label": "Написать менеджеру"})
    if structured.next_action == "create_lead" and products:
        actions.append({"type": "lead", "label": "Оставить заявку", "product_id": products[0].id})

    return {
        "text": text,
        # карточки и цены — ТОЛЬКО из БД (to_card), не из текста модели
        "cards": [p.to_card() for p in products],
        "actions": actions,
        "meta": {
            "source": "ai", "intent": structured.intent,
            "confidence": structured.confidence,
            "model": None,  # имя модели пользователю не раскрываем
            "retrieval_ms": retrieval_ms,
            "gateway_ms": gw.get("total_ms"),
            "latency_ms": int((time.monotonic() - t0) * 1000),
            "candidates": len(candidates),
            "dropped_ids": dropped,
            "state": filters.to_state(),
        },
    }
