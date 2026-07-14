"""Аналитика: вопрос, ответ, время, модель, токены, стоимость, кэш, ошибки, конверсия."""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


class Analytics:
    def __init__(self, engine: AsyncEngine):
        self.engine = engine

    async def log(self, **kw) -> int:
        async with self.engine.begin() as c:
            row = (await c.execute(text("""
                INSERT INTO ai_analytics(user_id, question, answer, intent, model, latency_ms,
                    prompt_tokens, completion_tokens, cost_usd, cache_hit, error)
                VALUES (:user_id,:question,:answer,:intent,:model,:latency_ms,
                    :prompt_tokens,:completion_tokens,:cost_usd,:cache_hit,:error)
                RETURNING id"""), {
                "user_id": kw.get("user_id"), "question": kw.get("question", ""),
                "answer": kw.get("answer"), "intent": kw.get("intent"),
                "model": kw.get("model"), "latency_ms": kw.get("latency_ms"),
                "prompt_tokens": kw.get("prompt_tokens", 0),
                "completion_tokens": kw.get("completion_tokens", 0),
                "cost_usd": kw.get("cost_usd", 0), "cache_hit": kw.get("cache_hit", False),
                "error": kw.get("error")})).first()
        return row[0]

    async def feedback(self, analytics_id: int | None, user_id: str, rating: int, comment: str):
        async with self.engine.begin() as c:
            await c.execute(text(
                "INSERT INTO ai_feedback(analytics_id,user_id,rating,comment) "
                "VALUES (:a,:u,:r,:c)"),
                {"a": analytics_id, "u": user_id, "r": rating, "c": comment})

    async def mark_converted(self, analytics_id: int):
        async with self.engine.begin() as c:
            await c.execute(text("UPDATE ai_analytics SET converted=TRUE WHERE id=:i"),
                            {"i": analytics_id})

    async def dashboard(self, days: int = 7) -> dict:
        """Данные для раздела AI в админке основного проекта."""
        async with self.engine.connect() as c:
            stats = (await c.execute(text("""
                SELECT count(*) AS requests,
                       coalesce(avg(latency_ms),0)::int AS avg_latency_ms,
                       coalesce(sum(cost_usd),0) AS total_cost_usd,
                       count(*) FILTER (WHERE cache_hit) AS cache_hits,
                       count(*) FILTER (WHERE error IS NOT NULL) AS errors,
                       count(*) FILTER (WHERE converted) AS conversions
                FROM ai_analytics WHERE created_at > now() - make_interval(days => :d)"""),
                {"d": days})).mappings().first()
            top = (await c.execute(text("""
                SELECT lower(question) q, count(*) n FROM ai_analytics
                WHERE created_at > now() - make_interval(days => :d)
                GROUP BY 1 ORDER BY n DESC LIMIT 10"""), {"d": days})).mappings().all()
            rating = (await c.execute(text(
                "SELECT coalesce(avg(rating),0) FROM ai_feedback "
                "WHERE created_at > now() - make_interval(days => :d)"), {"d": days})).scalar()
        return {"period_days": days, **dict(stats),
                "total_cost_usd": float(stats["total_cost_usd"]),
                "avg_rating": round(float(rating or 0), 2),
                "top_questions": [dict(r) for r in top]}
