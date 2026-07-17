"""AI Gateway — защищённый мост VPS -> Ollama (Mac mini), v5.1.

Единственная задача: принять от backend'а вопрос + недоверенный контекст +
кандидатов, сходить в локальную Ollama и вернуть строго структурированный
JSON-ответ модели. Никакой бизнес-логики, БД и shell-команд от LLM.

Hardening v5.1:
- format = точная JSON Schema (не просто "json") — надёжнее для qwen3;
- think: false — reasoning-токены qwen3 не нужны консультанту и режут латентность;
- keep_alive (OLLAMA_KEEP_ALIVE) — модель не выгружается между запросами;
- concurrency по умолчанию 1 (M4 Pro 24GB) + лимит ожидания очереди -> 503;
- /health = liveness (мгновенный), /ready = readiness (Ollama + модель скачана);
- один переиспользуемый AsyncClient вместо клиента на запрос;
- история диалога сюда НЕ приходит ролями: backend передаёт её недоверенным
  текстовым блоком в поле context (v5.1, anti prompt-injection).
"""
import asyncio
import hmac
import json
import logging
import os
import time
import uuid

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ---------- конфигурация из env ----------
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
OLLAMA_CHAT_MODEL = os.environ.get("OLLAMA_CHAT_MODEL", "qwen3:14b")
OLLAMA_FAST_MODEL = os.environ.get("OLLAMA_FAST_MODEL", "")  # опционально
OLLAMA_KEEP_ALIVE = os.environ.get("OLLAMA_KEEP_ALIVE", "30m")
AI_GATEWAY_API_KEY = os.environ.get("AI_GATEWAY_API_KEY", "")
AI_TIMEOUT_SECONDS = float(os.environ.get("AI_TIMEOUT_SECONDS", "45"))
AI_MAX_OUTPUT_TOKENS = int(os.environ.get("AI_MAX_OUTPUT_TOKENS", "700"))
AI_TEMPERATURE = float(os.environ.get("AI_TEMPERATURE", "0.4"))
MAX_CONCURRENCY = int(os.environ.get("AI_MAX_CONCURRENCY", "1"))
QUEUE_WAIT_SECONDS = float(os.environ.get("AI_QUEUE_WAIT_SECONDS", "10"))
RATE_LIMIT_PER_MINUTE = int(os.environ.get("AI_RATE_LIMIT_PER_MINUTE", "30"))
PAYLOAD_LIMIT_BYTES = int(os.environ.get("AI_PAYLOAD_LIMIT_BYTES", str(64 * 1024)))

logging.basicConfig(level=logging.INFO, format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":%(message)s}')
logger = logging.getLogger("ai-gateway")

app = FastAPI(title="AI Seller Gateway", docs_url=None, redoc_url=None, openapi_url=None)

_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
_hits: dict[str, list[float]] = {}
_http: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    """Один переиспользуемый AsyncClient (keep-alive соединения к Ollama)."""
    global _http
    if _http is None or _http.is_closed:
        _http = httpx.AsyncClient(timeout=AI_TIMEOUT_SECONDS)
    return _http


@app.on_event("shutdown")
async def _shutdown():
    if _http is not None and not _http.is_closed:
        await _http.aclose()


# Точная JSON Schema ответа (зеркалит backend/app/services/ai_schemas.py).
# Ollama structured outputs: format=<schema> надёжнее, чем format="json".
ANSWER_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": [
            "product_search", "comparison", "product_question", "general_help",
            "wholesale", "b2b", "trade_in", "manager", "unsupported"]},
        "answer": {"type": "string"},
        "follow_up_question": {"type": ["string", "null"]},
        "recommended_product_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 3},
        "comparison": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "product_id": {"type": "integer"},
                "best_for": {"type": "string"},
                "strengths": {"type": "array", "items": {"type": "string"}},
                "tradeoffs": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["product_id"],
        }},
        "filters": {"type": "object"},
        "next_action": {"type": "string", "enum": [
            "ask_question", "show_products", "create_lead", "open_manager", "none"]},
        "confidence": {"type": "number"},
    },
    "required": ["intent", "answer", "recommended_product_ids", "next_action"],
}


# ---------- schemas ----------
class ChatIn(BaseModel):
    system: str = Field(min_length=1, max_length=8000)
    message: str = Field(min_length=1, max_length=2000)
    # Недоверенный контекст (история диалога и т.п.) одним текстовым блоком.
    context: str = Field(default="", max_length=14000)
    candidates: list[dict] = Field(default_factory=list, max_length=12)
    fast: bool = False  # использовать быструю модель, если сконфигурирована


# ---------- guards ----------
def _check_api_key(request: Request) -> None:
    if not AI_GATEWAY_API_KEY:
        raise HTTPException(503, "Gateway is not configured")
    provided = request.headers.get("X-API-Key", "")
    if not hmac.compare_digest(provided, AI_GATEWAY_API_KEY):
        raise HTTPException(401, "Invalid API key")


def _check_rate_limit(key: str) -> None:
    now = time.monotonic()
    window = _hits.setdefault(key, [])
    window[:] = [t for t in window if now - t < 60]
    if len(window) >= RATE_LIMIT_PER_MINUTE:
        raise HTTPException(429, "Rate limit exceeded")
    window.append(now)


@app.middleware("http")
async def payload_limit(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and int(length) > PAYLOAD_LIMIT_BYTES:
        return JSONResponse({"detail": "Payload too large"}, status_code=413)
    return await call_next(request)


# ---------- endpoints ----------
@app.get("/health")
async def health():
    """Liveness: процесс жив. Мгновенно, без похода в Ollama, без секретов."""
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    """Readiness: Ollama доступна И нужная модель скачана."""
    try:
        r = await _client().get(f"{OLLAMA_BASE_URL}/api/tags")
        r.raise_for_status()
        models = [m.get("name", "") for m in r.json().get("models", [])]
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(503, f"Ollama unreachable: {type(e).__name__}")
    base = OLLAMA_CHAT_MODEL.split(":")[0]
    if not any(m == OLLAMA_CHAT_MODEL or m.startswith(base + ":") for m in models):
        raise HTTPException(503, f"Model {OLLAMA_CHAT_MODEL} is not pulled")
    return {"status": "ready", "models": models}


@app.post("/v1/chat")
async def chat(body: ChatIn, request: Request):
    _check_api_key(request)
    _check_rate_limit(request.client.host if request.client else "unknown")

    request_id = uuid.uuid4().hex[:12]
    model = OLLAMA_FAST_MODEL if (body.fast and OLLAMA_FAST_MODEL) else OLLAMA_CHAT_MODEL

    # system -> ЕДИНСТВЕННОЕ user-сообщение (products + недоверенный контекст + вопрос).
    # Клиентская история никогда не становится assistant-ролью (anti-injection).
    catalog_block = json.dumps(body.candidates, ensure_ascii=False)
    parts = [f"AVAILABLE_PRODUCTS = {catalog_block}"]
    if body.context:
        parts.append(body.context)
    parts.append(f"Текущее сообщение пользователя: {body.message}")
    messages = [
        {"role": "system", "content": body.system},
        {"role": "user", "content": "\n\n".join(parts)},
    ]

    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "format": ANSWER_SCHEMA,   # точная схема вместо "json"
        "think": False,            # qwen3: отключаем reasoning-токены
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "options": {
            "temperature": AI_TEMPERATURE,
            "num_predict": AI_MAX_OUTPUT_TOKENS,
        },
    }

    # Ограниченная очередь: ждём слот не дольше QUEUE_WAIT_SECONDS -> честный 503
    t0 = time.monotonic()
    try:
        await asyncio.wait_for(_semaphore.acquire(), timeout=QUEUE_WAIT_SECONDS)
    except (asyncio.TimeoutError, TimeoutError):
        logger.warning(json.dumps({"event": "queue_full", "request_id": request_id}))
        raise HTTPException(503, "Model is busy, try again shortly")
    try:
        content = await _call_ollama(payload, request_id)
    finally:
        _semaphore.release()
    total_ms = int((time.monotonic() - t0) * 1000)

    logger.info(json.dumps({
        "event": "chat_done", "request_id": request_id, "model": model,
        "context_chars": len(body.context), "candidates": len(body.candidates),
        "total_ms": total_ms, "output_chars": len(content),
    }, ensure_ascii=False))
    return {"content": content, "model": model, "total_ms": total_ms, "request_id": request_id}


async def _call_ollama(payload: dict, request_id: str) -> str:
    """Один вызов + один retry ТОЛЬКО на connect error (не на таймаут:
    повтор долгого inference лишь удвоит нагрузку)."""
    last_exc: Exception | None = None
    for attempt in (1, 2):
        try:
            resp = await _client().post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
            if resp.status_code != 200:
                logger.warning(json.dumps({"event": "ollama_http_error", "request_id": request_id,
                                           "status": resp.status_code}))
                raise HTTPException(502, "Ollama returned an error")
            data = resp.json()
            content = (data.get("message") or {}).get("content", "")
            if not content.strip():
                raise HTTPException(502, "Ollama returned empty content")
            return content
        except httpx.ConnectError as e:
            last_exc = e
            logger.warning(json.dumps({"event": "ollama_connect_retry", "request_id": request_id,
                                       "attempt": attempt}))
            await asyncio.sleep(0.5)
        except httpx.TimeoutException:
            logger.warning(json.dumps({"event": "ollama_timeout", "request_id": request_id}))
            raise HTTPException(504, "Model inference timed out")
        except (ValueError, KeyError):
            raise HTTPException(502, "Ollama returned malformed response")
    raise HTTPException(502, "Ollama is unreachable") from last_exc
