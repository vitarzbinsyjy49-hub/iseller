"""Retriever: Meilisearch (полнотекст) + PostgreSQL (фильтры). LLM получает ≤ N товаров."""
from meilisearch_python_sdk import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from ..config import get_settings

INDEX = "products"


class Retriever:
    def __init__(self, engine: AsyncEngine):
        s = get_settings()
        self.engine = engine
        self.meili = AsyncClient(s.meili_url, s.meili_key)

    async def ensure_index(self):
        idx = self.meili.index(INDEX)
        await idx.update_filterable_attributes(["brand", "category", "price", "in_stock"])
        await idx.update_searchable_attributes(["title", "brand", "category", "specs_text"])

    async def search(self, query: str, filters: dict, limit: int = 30) -> list[dict]:
        f = []
        if filters.get("brand"):
            f.append(f'brand = "{filters["brand"]}"')
        if filters.get("category"):
            f.append(f'category = "{filters["category"]}"')
        if filters.get("price_max"):
            f.append(f'price <= {int(filters["price_max"])}')
        if filters.get("price_min"):
            f.append(f'price >= {int(filters["price_min"])}')
        try:
            res = await self.meili.index(INDEX).search(
                query or "", limit=limit, filter=" AND ".join(f) if f else None)
            hits = res.hits
            if hits:
                return await self._hydrate([h["id"] for h in hits],
                                           {h["id"]: 1 - i / max(len(hits), 1)
                                            for i, h in enumerate(hits)})
        except Exception:
            pass  # Meili недоступен → SQL-fallback ниже
        return await self._sql_fallback(query, filters, limit)

    async def _hydrate(self, ids: list[int], scores: dict) -> list[dict]:
        async with self.engine.connect() as c:
            rows = (await c.execute(
                text("SELECT * FROM products WHERE id = ANY(:ids)"), {"ids": ids})).mappings().all()
        out = [dict(r) for r in rows]
        for p in out:
            p["_relevance"] = scores.get(p["id"], 0.0)
        return sorted(out, key=lambda p: -p["_relevance"])

    async def _sql_fallback(self, query: str, filters: dict, limit: int) -> list[dict]:
        where, params = ["TRUE"], {"limit": limit}
        if query:
            where.append("(title ILIKE :q OR brand ILIKE :q OR category ILIKE :q)")
            params["q"] = f"%{query.split()[0]}%"
        for k, op in (("price_max", "price <= :price_max"), ("price_min", "price >= :price_min")):
            if filters.get(k):
                where.append(op); params[k] = int(filters[k])
        if filters.get("brand"):
            where.append("brand ILIKE :brand"); params["brand"] = filters["brand"]
        if filters.get("category"):
            where.append("category ILIKE :cat"); params["cat"] = f"%{filters['category']}%"
        sql = f"SELECT * FROM products WHERE {' AND '.join(where)} ORDER BY popularity DESC LIMIT :limit"
        async with self.engine.connect() as c:
            rows = (await c.execute(text(sql), params)).mappings().all()
        out = [dict(r) for r in rows]
        for p in out:
            p["_relevance"] = 0.5
        return out
