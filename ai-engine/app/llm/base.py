"""Единый интерфейс LLM. Любой провайдер заменяется без правок остального кода."""
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class LLMResult:
    text: str
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    model: str = ""
    provider: str = ""


class LLMProvider(ABC):
    name: str = "base"

    @abstractmethod
    async def complete(self, prompt: str, *, temperature: float = 0.2,
                       max_tokens: int = 600) -> LLMResult:
        ...
