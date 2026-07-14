"""Реализации провайдеров: Ollama (Qwen/Gemma/DeepSeek и др.), OpenAI, Anthropic, Gemini."""
import httpx

from app.config import get_settings
from app.llm.base import LLMProvider, LLMResult

_TIMEOUT = httpx.Timeout(60.0, connect=5.0)

# Ориентировочные цены $/1M токенов для учёта стоимости; правится в одном месте
PRICING = {"openai": (0.15, 0.60), "anthropic": (0.80, 4.00),
           "gemini": (0.10, 0.40), "ollama": (0.0, 0.0)}


def _cost(provider: str, t_in: int, t_out: int) -> float:
    p_in, p_out = PRICING.get(provider, (0, 0))
    return (t_in * p_in + t_out * p_out) / 1_000_000


class OllamaProvider(LLMProvider):
    name = "ollama"

    async def complete(self, prompt, *, temperature=0.2, max_tokens=600) -> LLMResult:
        s = get_settings()
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(f"{s.ollama_url}/api/generate", json={
                "model": s.llm_model, "prompt": prompt, "stream": False,
                "options": {"temperature": temperature, "num_predict": max_tokens}})
            r.raise_for_status()
            d = r.json()
        return LLMResult(text=d.get("response", "").strip(),
                         tokens_in=d.get("prompt_eval_count", 0) or 0,
                         tokens_out=d.get("eval_count", 0) or 0,
                         cost_usd=0.0, model=s.llm_model, provider=self.name)


class OpenAIProvider(LLMProvider):
    name = "openai"

    async def complete(self, prompt, *, temperature=0.2, max_tokens=600) -> LLMResult:
        s = get_settings()
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post("https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {s.openai_api_key}"},
                json={"model": s.llm_model, "temperature": temperature,
                      "max_tokens": max_tokens,
                      "messages": [{"role": "user", "content": prompt}]})
            r.raise_for_status()
            d = r.json()
        u = d.get("usage", {})
        t_in, t_out = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
        return LLMResult(text=d["choices"][0]["message"]["content"].strip(),
                         tokens_in=t_in, tokens_out=t_out,
                         cost_usd=_cost(self.name, t_in, t_out),
                         model=s.llm_model, provider=self.name)


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    async def complete(self, prompt, *, temperature=0.2, max_tokens=600) -> LLMResult:
        s = get_settings()
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": s.anthropic_api_key,
                         "anthropic-version": "2023-06-01"},
                json={"model": s.llm_model, "max_tokens": max_tokens,
                      "temperature": temperature,
                      "messages": [{"role": "user", "content": prompt}]})
            r.raise_for_status()
            d = r.json()
        u = d.get("usage", {})
        t_in, t_out = u.get("input_tokens", 0), u.get("output_tokens", 0)
        text = "".join(b.get("text", "") for b in d.get("content", [])).strip()
        return LLMResult(text=text, tokens_in=t_in, tokens_out=t_out,
                         cost_usd=_cost(self.name, t_in, t_out),
                         model=s.llm_model, provider=self.name)


class GeminiProvider(LLMProvider):
    name = "gemini"

    async def complete(self, prompt, *, temperature=0.2, max_tokens=600) -> LLMResult:
        s = get_settings()
        url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
               f"{s.llm_model}:generateContent?key={s.gemini_api_key}")
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(url, json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": temperature,
                                     "maxOutputTokens": max_tokens}})
            r.raise_for_status()
            d = r.json()
        text = d["candidates"][0]["content"]["parts"][0]["text"].strip()
        u = d.get("usageMetadata", {})
        t_in, t_out = u.get("promptTokenCount", 0), u.get("candidatesTokenCount", 0)
        return LLMResult(text=text, tokens_in=t_in, tokens_out=t_out,
                         cost_usd=_cost(self.name, t_in, t_out),
                         model=s.llm_model, provider=self.name)
