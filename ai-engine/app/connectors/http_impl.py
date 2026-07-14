"""HTTP-реализации коннекторов. Меняются URL в .env — код не трогается.
Если API вашего проекта отличается — правится ТОЛЬКО этот файл.

FIX (integration): экспорт каталога основного проекта закрыт ключом,
поэтому коннектор теперь отправляет заголовок X-API-Key (CATALOG_API_KEY в .env).
"""
import httpx
from .base import CatalogConnector, CRMConnector
from ..config import get_settings


class HttpCatalogConnector(CatalogConnector):
    async def fetch_products(self, updated_since=None) -> list[dict]:
        s = get_settings()
        if not s.catalog_api_url:
            return []
        params = {"updated_since": updated_since} if updated_since else {}
        headers = {"X-API-Key": s.catalog_api_key} if s.catalog_api_key else {}
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(s.catalog_api_url, params=params, headers=headers)
            r.raise_for_status()
            return r.json()


class HttpCRMConnector(CRMConnector):
    async def get_customer(self, user_id):
        s = get_settings()
        if not s.crm_api_url:
            return None
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{s.crm_api_url}/customers/{user_id}")
            return r.json() if r.status_code == 200 else None

    async def notify_purchase(self, user_id, order):
        return None  # конверсию проставляет ваш бэкенд через POST /events/purchase
