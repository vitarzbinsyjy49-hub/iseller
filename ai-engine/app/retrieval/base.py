"""Retriever: интерфейс поиска. Backend меняется через SEARCH_BACKEND без правок пайплайна.
LLM никогда не видит полный каталог — только top-K результатов поиска."""
from abc import ABC, abstractmethod


class Retriever(ABC):
    @abstractmethod
    async def search_products(self, query: str, filters: dict, limit: int = 20) -> list[dict]:
        ...

    @abstractmethod
    async def search_knowledge(self, query: str, limit: int = 5) -> list[dict]:
        ...
