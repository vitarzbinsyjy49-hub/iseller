"""Слой адаптеров: AI Engine не знает деталей вашего проекта — только контракты."""
from abc import ABC, abstractmethod


class CatalogConnector(ABC):
    """Источник правды о товарах — ВАШ каталог. Engine хранит синхронизируемую копию."""
    @abstractmethod
    async def fetch_products(self, updated_since: str | None = None) -> list[dict]: ...


class CRMConnector(ABC):
    @abstractmethod
    async def get_customer(self, user_id: str) -> dict | None: ...
    @abstractmethod
    async def notify_purchase(self, user_id: str, order: dict) -> None: ...


class NotificationConnector(ABC):
    @abstractmethod
    async def send(self, user_id: str, message: str) -> None: ...
