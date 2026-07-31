"""Публичная конфигурация витрины (v4 pre-launch).

GET /api/config/public — только безопасные значения: бренд и контакты
менеджеров. Секреты (токены, пароли, JWT_SECRET, ключи) сюда не попадают
никогда: поля перечислены явно, а не собираются из settings автоматически.

Эндпоинт без auth: фронтенду ссылки нужны до логина, ничего приватного тут нет.
"""
from fastapi import APIRouter

from app.core.config import settings

router = APIRouter(prefix="/config", tags=["config"])

#: Какие значения AI_PROVIDER означают, что отвечает именно Claude.
#: `ollama_remote` — это Ollama на Mac mini, `fallback`/`mock` — ответ по
#: каталогу вообще без модели. Ни то, ни другое Claude не является.
_CLAUDE_PROVIDERS = frozenset({"anthropic"})


def ai_vendor() -> str:
    """Кто на самом деле отвечает в AI-подборе прямо сейчас.

    Витрина показывает «Powered by Claude» ТОЛЬКО по этому полю, а не по
    константе во фронте. Иначе на локальном стенде с `AI_PROVIDER=fallback`
    магазин утверждал бы, что за подбор отвечает Claude, хотя ответ собран из
    каталога без единого обращения к модели. Утверждение о том, чем работает
    магазин, обязано быть проверяемым — как и всё остальное на витрине.
    """
    return "claude" if (settings.AI_PROVIDER or "").strip().lower() in _CLAUDE_PROVIDERS else ""


@router.get("/public")
def public_config():
    retail = settings.MANAGER_RETAIL_URL.strip()
    # Специализированные менеджеры пока могут быть не назначены —
    # тогда все обращения идут розничному (fallback на бэке, чтобы
    # фронтенду не дублировать эту логику).
    return {
        "app_name": settings.APP_NAME,
        "manager_retail_url": retail,
        "manager_wholesale_url": settings.MANAGER_WHOLESALE_URL.strip() or retail,
        "manager_b2b_url": settings.MANAGER_B2B_URL.strip() or retail,
        "manager_tradein_url": settings.MANAGER_TRADEIN_URL.strip() or retail,
        "telegram_channel_url": settings.TELEGRAM_CHANNEL_URL.strip(),
        "mini_app_url": settings.MINI_APP_URL.strip(),
        # @username бота без «@». Не секрет: он и так стоит в каждой кнопке
        # каждого поста канала. Фронту нужен, чтобы «поделиться товаром» слал
        # deep link t.me/<bot>?start=product_<id>, а не внутренний адрес Mini
        # App — по внутреннему адресу получатель попадает в веб-версию без
        # Telegram-авторизации и видит «Не удалось войти».
        "bot_username": settings.BOT_USERNAME.strip().lstrip("@"),
        # Пусто => движок не Claude, и бейджа на витрине не будет.
        "ai_vendor": ai_vendor(),
        "ai_model": settings.AI_ANTHROPIC_MODEL.strip() if ai_vendor() else "",
    }
