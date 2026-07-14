"""Поиск по PostgreSQL: full-text (russian) + фильтры. Работает без внешнего движка."""
import asyncpg

from app.config import get_settings
from app.retrieval.base import Retriever

_pool = None


async def get_pool():
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(get_settings().database_url,
                                          min_size=1, max_size=10)
    return _pool


class PostgresRetriever(Retriever):
    async def search_products(self, query, filters, limit=20):
        pool = await get_pool()
        conditions, args = ["true"], []

        if query:
            args.append(query)
            n = len(args)
            conditions.append(
                f"(to_tsvector('russian', coalesce(search_text,'')) @@ "
                f"plainto_tsquery('russian', ${n}) OR title ILIKE '%' || ${n} || '%')")
        if filters.get("category"):
            args.append(f"%{filters['category']}%")
            conditions.append(f"category ILIKE ${len(args)}")
        if filters.get("brand"):
            args.append(f"%{filters['brand']}%")
            conditions.append(f"brand ILIKE ${len(args)}")
        if filters.get("price_max"):
            args.append(float(filters["price_max"]))
            conditions.append(f"price <= ${len(args)}")
        if filters.get("price_min"):
            args.append(float(filters["price_min"]))
            conditions.append(f"price >= ${len(args)}")

        args.append(limit)
        sql = f"""
            SELECT id, title, brand, category, price, old_price, in_stock, stock_qty,
                   rating, popularity, margin, is_promo, image_url, specs
            FROM products WHERE {' AND '.join(conditions)}
            ORDER BY in_stock DESC, popularity DESC LIMIT ${len(args)}"""
        rows = await pool.fetch(sql, *args)
        return [dict(r) for r in rows]

    async def search_knowledge(self, query, limit=5):
        pool = await get_pool()
        rows = await pool.fetch(
            """SELECT source, title, content FROM knowledge_chunks
               WHERE to_tsvector('russian', content) @@ plainto_tsquery('russian', $1)
                  OR content ILIKE '%' || $1 || '%'
               LIMIT $2""", query, limit)
        return [dict(r) for r in rows]
