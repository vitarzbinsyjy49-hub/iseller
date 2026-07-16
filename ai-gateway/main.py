"""AI Gateway — защищённый мост VPS -> Ollama (Mac mini), v5.

Единственная задача: принять от backend'а вопрос + историю + кандидатов,
сходить в локальную Ollama и вернуть сырой JSON-ответ модели. Никакой
бизнес-логики, никакого доступа к БД, никаких shell-команд от LLM.

Guardrails:
- аутентификация по X-API-Key (constant-time сравнение);
- лимит размера payload (PAYLOAD_LIMIT_BYTES);
- лимит истории/кандидатов/длин строк;
- rate limit (in-memory sliding window);
- ограничение параллельных inference (semaphore) — бережём Mac mini;
- таймаут Ollama + один retry только на connect error;
- структурные логи без содержимого сообщений (privacy);
- /health не раскрывает секреты.
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
AI_GATEWAY_API_KEY = os.environ.get("AI_GATEWAY_API_KEY", "")
AI_TIMEOUT_SECONDS = float(os.environ.get("AI_TIMEOUT_SECONDS", "45"))
AI_MAX_OUTPUT_TOKENS = int(os.environ.get("AI_MAX_OUTPUT_TOKENS", "700"))
AI_TEMPERATURE = float(os.environ.get("AI_TEMPERATURE", "0.4"))
MAX_CONCURRENCY = int(os.environ.get("AI_MAX_CONCURRENCY", "2"))
RATE_LIMIT_PER_MINUTE = int(os.environ.get("AI_RATE_LIMIT_PER_MINUTE", "30"))
PAYLOAD_LIMIT_BYTES = int(os.environ.get("AI_PAYLOAD_LIMIT_BYTES", str(64 * 1024)))

logging.basicConfig(level=logging.INFO, format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":%(message)s}')
logger = logging.getLogger("ai-gateway")

app = FastAPI(title="AI Seller Gateway", docs_url=None, redoc_url=None, openapi_url=None)

_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
_hits: dict[str, list[float]] = {}


# ---------- schemas ----------
class HistoryItem(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=2000)


class ChatIn(BaseModel):
    system: str = Field(min_length=1, max_length=8000)
    message: str = Field(min_length=1, max_length=2000)
    history: list[HistoryItem] = Field(default_factory=list, max_length=10)
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
    """Живость гейтвея и достижимость Ollama. Никаких секретов."""
    ollama = "unknown"
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_BASE_URL}/api/version")
            ollama = "ok" if r.status_code == 200 else f"http_{r.status_code}"
    except httpx.HTTPError:
        ollama = "unreachable"
    return {"status": "ok", "ollama": ollama, "concurrency": MAX_CONCURRENCY}


@app.post("/v1/chat")
async def chat(body: ChatIn, request: Request):
    _check_api_key(request)
    _check_rate_limit(request.client.host if request.client else "unknown")

    request_id = uuid.uuid4().hex[:12]
    model = OLLAMA_FAST_MODEL if (body.fast and OLLAMA_FAST_MODEL) else OLLAMA_CHAT_MODEL

    # Собираем сообщения: system -> история -> вопрос + данные.
    # Кандидаты кладём в user-сообщение отдельным блоком AVAILABLE_PRODUCTS.
    catalog_block = json.dumps(body.candidates, ensure_ascii=False)
    user_content = (
        f"AVAILABLE_PRODUCTS = {catalog_block}\n\n"
        f"Сообщение пользователя: {body.message}"
    )
    messages = [{"role": "system", "content": body.system}]
    messages += [{"role": h.role, "content": h.content} for h in body.history]
    messages.append({"role": "user", "content": user_content})

    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "format": "json",  # Ollama заставляет модель отдавать валидный JSON
        "options": {
            "temperature": AI_TEMPERATURE,
            "num_predict": AI_MAX_OUTPUT_TOKENS,
        },
    }

    t0 = time.monotonic()
    async with _semaphore:  # не даём положить Mac mini параллельными inference
        content = await _call_ollama(payload, request_id)
    total_ms = int((time.monotonic() - t0) * 1000)

    logger.info(json.dumps({
        "event": "chat_done", "request_id": request_id, "model": model,
        "history": len(body.history), "candidates": len(body.candidates),
        "total_ms": total_ms, "output_chars": len(content),
    }, ensure_ascii=False))
    return {"content": content, "model": model, "total_ms": total_ms, "request_id": request_id}


async def _call_ollama(payload: dict, request_id: str) -> str:
    """Один вызов + один retry ТОЛЬКО на connect error (не на таймаут:
    повтор долгого inference лишь удвоит нагрузку)."""
    last_exc: Exception | None = None
    for attempt in (1, 2):
        try:
            async with httpx.AsyncClient(timeout=AI_TIMEOUT_SECONDS) as client:
                resp = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
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
