"""Тесты AI Gateway (v5.1): guardrails без реальной Ollama."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)
KEY = "test-key-123"


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(main, "AI_GATEWAY_API_KEY", KEY)
    main._hits.clear()
    yield


def _chat(payload=None, key=KEY, **extra):
    body = {"system": "s", "message": "привет", "candidates": [], **(payload or {}), **extra}
    return client.post("/v1/chat", json=body, headers={"X-API-Key": key} if key else {})


# ---------- auth ----------

def test_wrong_api_key_401():
    assert _chat(key="wrong").status_code == 401


def test_missing_api_key_401():
    assert _chat(key=None).status_code == 401


def test_unconfigured_key_503(monkeypatch):
    monkeypatch.setattr(main, "AI_GATEWAY_API_KEY", "")
    assert _chat().status_code == 503


# ---------- лимиты ----------

def test_payload_limit_413(monkeypatch):
    monkeypatch.setattr(main, "PAYLOAD_LIMIT_BYTES", 100)
    r = client.post("/v1/chat", content=b"x" * 200,
                    headers={"X-API-Key": KEY, "Content-Type": "application/json",
                             "Content-Length": "200"})
    assert r.status_code == 413


def test_rate_limit_429(monkeypatch):
    monkeypatch.setattr(main, "RATE_LIMIT_PER_MINUTE", 2)
    async def ok(payload, request_id):
        return "{}"
    monkeypatch.setattr(main, "_call_ollama", ok)
    assert _chat().status_code == 200
    assert _chat().status_code == 200
    assert _chat().status_code == 429


def test_history_field_rejected_as_unknown_shape():
    # v5.1: ролевой истории больше нет; лишние поля игнорируются pydantic'ом,
    # но контекст с превышением лимита должен резаться 422
    r = _chat({"context": "x" * 15000})
    assert r.status_code == 422


# ---------- сборка payload для Ollama ----------

def test_payload_uses_schema_think_false_keep_alive(monkeypatch):
    captured = {}
    async def capture(payload, request_id):
        captured.update(payload)
        return '{"ok": true}'
    monkeypatch.setattr(main, "_call_ollama", capture)
    r = _chat({"context": "UNTRUSTED_CONVERSATION_DATA:\nuser: тест"})
    assert r.status_code == 200
    assert captured["format"] == main.ANSWER_SCHEMA      # точная JSON Schema
    assert captured["think"] is False                     # qwen3 без reasoning
    assert captured["keep_alive"] == main.OLLAMA_KEEP_ALIVE
    assert captured["options"]["num_predict"] == main.AI_MAX_OUTPUT_TOKENS
    # ровно 2 сообщения: system + один user (история не ролями)
    roles = [m["role"] for m in captured["messages"]]
    assert roles == ["system", "user"]
    user_msg = captured["messages"][1]["content"]
    assert "AVAILABLE_PRODUCTS" in user_msg
    assert "UNTRUSTED_CONVERSATION_DATA" in user_msg


def test_queue_busy_503(monkeypatch):
    monkeypatch.setattr(main, "QUEUE_WAIT_SECONDS", 0.05)
    # займём единственный слот
    main._semaphore._value = 0  # noqa: SLF001 — иначе пришлось бы держать реальный inference
    try:
        assert _chat().status_code == 503
    finally:
        main._semaphore._value = main.MAX_CONCURRENCY


# ---------- ответы Ollama ----------

def test_malformed_ollama_response_502(monkeypatch):
    class FakeResp:
        status_code = 200
        def json(self):
            raise ValueError("not json")
    class FakeClient:
        async def post(self, url, json):
            return FakeResp()
        async def get(self, url):
            return FakeResp()
    monkeypatch.setattr(main, "_client", lambda: FakeClient())
    assert _chat().status_code == 502


def test_empty_content_502(monkeypatch):
    class FakeResp:
        status_code = 200
        def json(self):
            return {"message": {"content": "   "}}
    class FakeClient:
        async def post(self, url, json):
            return FakeResp()
    monkeypatch.setattr(main, "_client", lambda: FakeClient())
    assert _chat().status_code == 502


# ---------- health/ready ----------

def test_health_is_instant_and_secretless():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}          # никаких ключей/моделей/путей


def test_ready_fails_without_model(monkeypatch):
    class FakeResp:
        status_code = 200
        def raise_for_status(self):
            pass
        def json(self):
            return {"models": [{"name": "llama3:8b"}]}
    class FakeClient:
        async def get(self, url):
            return FakeResp()
    monkeypatch.setattr(main, "_client", lambda: FakeClient())
    assert client.get("/ready").status_code == 503


def test_ready_ok_with_model(monkeypatch):
    class FakeResp:
        status_code = 200
        def raise_for_status(self):
            pass
        def json(self):
            return {"models": [{"name": main.OLLAMA_CHAT_MODEL}]}
    class FakeClient:
        async def get(self, url):
            return FakeResp()
    monkeypatch.setattr(main, "_client", lambda: FakeClient())
    r = client.get("/ready")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"
