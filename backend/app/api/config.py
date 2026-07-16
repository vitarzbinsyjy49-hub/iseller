"""Публичная конфигурация витрины (v4 pre-launch).

GET /api/config/public — только безопасные значения: бренд и контакты
менеджеров. Секреты (токены, пароли, JWT_SECRET, ключи) сюда не попадают
никогда: поля перечислены явно, а не собираются из settings автоматически.

Эндпоинт без auth: фронтенду ссылки нужны до логина, ничего приватного тут нет.
"""
from fastapi import APIRouter

from app.core.config import settings

router = APIRouter(prefix="/config", tags=["config"])


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
    }
