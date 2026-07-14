"""Memory Engine: профиль, история, предпочтения."""
import json
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


class Memory:
    def __init__(self, engine: AsyncEngine):
        self.engine = engine

    async def get_profile(self, user_id: str) -> dict:
        async with self.engine.connect() as c:
            row = (await c.execute(text("SELECT * FROM user_memory WHERE user_id=:u"),
                                   {"u": user_id})).mappings().first()
        return dict(row) if row else {}

    async def remember_interaction(self, user_id: str, question: str, answer: str,
                                   intent: str, product_ids: list[int]):
        async with self.engine.begin() as c:
            await c.execute(text(
                "INSERT INTO chat_history(user_id,role,content,intent,product_ids) "
                "VALUES (:u,'user',:q,:i,'[]'),(:u,'assistant',:a,:i,:p)"),
                {"u": user_id, "q": question, "a": answer, "i": intent,
                 "p": json.dumps(product_ids)})
            await c.execute(text("""
                INSERT INTO user_memory(user_id, viewed_products)
                VALUES (:u, :p)
                ON CONFLICT (user_id) DO UPDATE SET
                  viewed_products = (
                    SELECT jsonb_agg(x) FROM (
                      SELECT DISTINCT x FROM jsonb_array_elements(
                        user_memory.viewed_products || EXCLUDED.viewed_products) x
                      LIMIT 50) s),
                  updated_at = now()"""),
                {"u": user_id, "p": json.dumps(product_ids)})

    async def update_preferences(self, user_id: str, brands: list[str] | None = None,
                                 categories: list[str] | None = None,
                                 budget: tuple | None = None):
        async with self.engine.begin() as c:
            await c.execute(text("""
                INSERT INTO user_memory(user_id, favorite_brands, favorite_categories,
                                        budget_min, budget_max)
                VALUES (:u, :b, :c, :bmin, :bmax)
                ON CONFLICT (user_id) DO UPDATE SET
                  favorite_brands = COALESCE(NULLIF(EXCLUDED.favorite_brands,'[]'::jsonb),
                                             user_memory.favorite_brands),
                  favorite_categories = COALESCE(NULLIF(EXCLUDED.favorite_categories,'[]'::jsonb),
                                                 user_memory.favorite_categories),
                  budget_min = COALESCE(EXCLUDED.budget_min, user_memory.budget_min),
                  budget_max = COALESCE(EXCLUDED.budget_max, user_memory.budget_max),
                  updated_at = now()"""),
                {"u": user_id, "b": json.dumps(brands or []), "c": json.dumps(categories or []),
                 "bmin": budget[0] if budget else None, "bmax": budget[1] if budget else None})

    async def history(self, user_id: str, limit: int = 20) -> list[dict]:
        async with self.engine.connect() as c:
            rows = (await c.execute(text(
                "SELECT role, content, intent, product_ids, created_at FROM chat_history "
                "WHERE user_id=:u ORDER BY created_at DESC LIMIT :l"),
                {"u": user_id, "l": limit})).mappings().all()
        return [dict(r) for r in rows]
