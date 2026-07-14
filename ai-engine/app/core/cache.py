"""Интеллектуальный кэш: одинаковые (нормализованные) вопросы не идут в LLM.
Redis — горячий слой, Postgres — тёплый (переживает рестарт)."""
import hashlib, json, re
import redis.asyncio as aioredis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from ..config import get_settings


def cache_key(question: str, intent: str, filters: dict) -> str:
    norm = re.sub(r"[^\wа-яё0-9 ]", "", question.lower()).strip()
    norm = re.sub(r"\s+", " ", norm)
    raw = json.dumps({"q": norm, "i": intent, "f": filters}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


class Cache:
    def __init__(self, engine: AsyncEngine):
        s = get_settings()
        self.enabled = s.semantic_cache_enabled
        self.ttl = s.cache_ttl_seconds
        self.redis = aioredis.from_url(s.redis_url, decode_responses=True)
        self.engine = engine

    async def get(self, key: str) -> dict | None:
        if not self.enabled:
            return None
        try:
            if v := await self.redis.get(f"ans:{key}"):
                return json.loads(v)
        except Exception:
            pass
        async with self.engine.connect() as c:
            row = (await c.execute(text(
                "SELECT payload FROM answer_cache WHERE key=:k AND expires_at > now()"),
                {"k": key})).first()
        if row:
            async with self.engine.begin() as c:
                await c.execute(text("UPDATE answer_cache SET hits=hits+1 WHERE key=:k"), {"k": key})
            return row[0]
        return None

    async def set(self, key: str, payload: dict):
        if not self.enabled:
            return
        data = json.dumps(payload, ensure_ascii=False, default=str)
        try:
            await self.redis.set(f"ans:{key}", data, ex=self.ttl)
        except Exception:
            pass
        async with self.engine.begin() as c:
            await c.execute(text("""
                INSERT INTO answer_cache(key, payload, expires_at)
                VALUES (:k, :p, now() + make_interval(secs => :ttl))
                ON CONFLICT (key) DO UPDATE SET payload=:p,
                  expires_at=now() + make_interval(secs => :ttl)"""),
                {"k": key, "p": data, "ttl": self.ttl})
