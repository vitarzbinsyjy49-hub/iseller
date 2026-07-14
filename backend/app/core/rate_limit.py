"""Rate limiter для /api/ai/chat (v2).

Дизайн-требования:
- ключ = user_id (если авторизован), иначе fallback на IP;
- дефолт 10 запросов/мин, настраивается AI_CHAT_RATE_LIMIT_PER_MINUTE;
- НЕ требует внешнего платного сервиса: по умолчанию in-memory sliding window;
- опциональный Redis (RATE_LIMIT_REDIS_URL) для нескольких инстансов backend;
- Redis недоступен -> мягкая деградация на in-memory, backend не падает;
- ошибка самого лимитера НИКОГДА не роняет запрос (fail-open): пропускаем.

Скользящее окно 60 секунд. Проверка и учёт — атомарно на процесс (threading.Lock),
чего достаточно для одного uvicorn-воркера dev/staging. Для нескольких воркеров/реплик
включите Redis.
"""
import logging
import threading
import time

from app.core.config import settings

logger = logging.getLogger("techshop.ratelimit")

_WINDOW_SECONDS = 60

# ---- in-memory состояние ----
_hits: dict[str, list[float]] = {}
_lock = threading.Lock()

# ---- опциональный Redis ----
_redis = None
_redis_ready = False


def _init_redis() -> None:
    """Ленивая инициализация Redis. Любая ошибка -> тихо остаёмся на in-memory."""
    global _redis, _redis_ready
    if _redis_ready:
        return
    _redis_ready = True
    url = settings.RATE_LIMIT_REDIS_URL
    if not url:
        return
    try:
        import redis  # redis-py; синхронный клиент достаточно для INCR/EXPIRE

        client = redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1)
        client.ping()
        _redis = client
        logger.info("Rate limit backend: Redis (%s)", url)
    except Exception as e:  # noqa: BLE001 — деградация должна ловить всё
        _redis = None
        logger.warning("Rate limit: Redis unavailable (%s), falling back to in-memory", e)


def _limit_per_minute() -> int:
    try:
        return max(1, int(settings.AI_CHAT_RATE_LIMIT_PER_MINUTE))
    except Exception:  # noqa: BLE001
        return 10


def _allow_in_memory(key: str, limit: int) -> bool:
    now = time.monotonic()
    cutoff = now - _WINDOW_SECONDS
    with _lock:
        bucket = _hits.get(key)
        if bucket is None:
            bucket = []
            _hits[key] = bucket
        # выбрасываем всё старше окна
        i = 0
        for i, ts in enumerate(bucket):
            if ts > cutoff:
                break
        else:
            i = len(bucket)
        if i:
            del bucket[:i]
        if len(bucket) >= limit:
            return False
        bucket.append(now)
        # лёгкая уборка, чтобы словарь не рос бесконечно
        if len(_hits) > 10000:
            _hits.pop(next(iter(_hits)), None)
        return True


def _allow_redis(key: str, limit: int) -> bool:
    """Фиксированное окно на 60с через INCR+EXPIRE. Ошибка -> сигнал перейти на in-memory."""
    global _redis
    try:
        redis_key = f"ai_chat_rl:{key}:{int(time.time() // _WINDOW_SECONDS)}"
        pipe = _redis.pipeline()
        pipe.incr(redis_key, 1)
        pipe.expire(redis_key, _WINDOW_SECONDS)
        count, _ = pipe.execute()
        return int(count) <= limit
    except Exception as e:  # noqa: BLE001
        logger.warning("Rate limit: Redis error (%s), switching to in-memory", e)
        _redis = None  # больше не пытаемся в этом процессе
        raise


def check_rate_limit(key: str) -> bool:
    """True — запрос разрешён, False — превышен лимит.

    fail-open: при любой внутренней ошибке возвращает True (не блокируем пользователя
    из-за проблем самого лимитера).
    """
    try:
        _init_redis()
        limit = _limit_per_minute()
        if _redis is not None:
            try:
                return _allow_redis(key, limit)
            except Exception:  # noqa: BLE001 — Redis сломался в рантайме
                return _allow_in_memory(key, limit)
        return _allow_in_memory(key, limit)
    except Exception:  # noqa: BLE001
        logger.exception("Rate limit check failed; allowing request (fail-open)")
        return True
