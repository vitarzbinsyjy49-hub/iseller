"""Meilisearch backend: опечатко-устойчивый поиск. Индекс наполняет Catalog Connector."""
from meilisearch_python_sdk import AsyncClient

from app.config import get_settings
from app.retrieval.base import Retriever


class MeilisearchRetriever(Retriever):
    def _client(self) -> AsyncClient:
        s = get_settings()
        return AsyncClient(s.meilisearch_url, s.meilisearch_key)

    async def search_products(self, query, filters, limit=20):
        f = []
        if filters.get("price_max"):
            f.append(f"price <= {float(filters['price_max'])}")
        if filters.get("price_min"):
            f.append(f"price >= {float(filters['price_min'])}")
        if filters.get("brand"):
            f.append("brand = '{}'".format(str(filters["brand"]).replace("'", "")))
        if filters.get("category"):
            f.append("category = '{}'".format(str(filters["category"]).replace("'", "")))
        async with self._client() as c:
            res = await c.index("products").search(
                query or "", limit=limit, filter=" AND ".join(f) or None)
        return res.hits

    async def search_knowledge(self, query, limit=5):
        async with self._client() as c:
            res = await c.index("knowledge").search(query, limit=limit)
        return res.hits
