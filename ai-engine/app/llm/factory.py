"""Фабрика провайдеров: LLM_PROVIDER в .env — единственная точка выбора модели.

FIX (integration): app/main.py импортирует build_llm, которого не было —
добавлен алиас, сервис теперь стартует.
"""
from app.config import get_settings
from app.llm.base import LLMProvider
from app.llm.providers import (AnthropicProvider, GeminiProvider,
                               OllamaProvider, OpenAIProvider)

_REGISTRY: dict[str, type[LLMProvider]] = {
    "ollama": OllamaProvider,
    "openai": OpenAIProvider,
    "anthropic": AnthropicProvider,
    "gemini": GeminiProvider,
}


def get_llm() -> LLMProvider:
    name = get_settings().llm_provider.lower()
    if name not in _REGISTRY:
        raise ValueError(f"Unknown LLM_PROVIDER '{name}'. Options: {list(_REGISTRY)}")
    return _REGISTRY[name]()


# Алиас для app/main.py (там исторически импортируется build_llm)
build_llm = get_llm
