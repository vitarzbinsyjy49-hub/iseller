"""Синхронизация каталога: ваш проект -> локальная таблица products + Meilisearch."""
import json
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from .base import CatalogConnector
from ..core.retriever import INDEX
from meilisearch_python_sdk import AsyncClient
from ..config import get_settings


async def sync_catalog(engine: AsyncEngine, connector: CatalogConnector) -> int:
    products = await connector.fetch_products()
    if not products:
        return 0
    async with engine.begin() as c:
        for p in products:
            await c.execute(text("""
                INSERT INTO products(id,title,brand,category,price,old_price,in_stock,rating,
                    popularity,margin_pct,is_new,on_sale,specs,image,url,updated_at)
                VALUES (:id,:title,:brand,:category,:price,:old_price,:in_stock,:rating,
                    :popularity,:margin_pct,:is_new,:on_sale,:specs,:image,:url,now())
                ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, brand=EXCLUDED.brand,
                    category=EXCLUDED.category, price=EXCLUDED.price, old_price=EXCLUDED.old_price,
                    in_stock=EXCLUDED.in_stock, rating=EXCLUDED.rating,
                    popularity=EXCLUDED.popularity, margin_pct=EXCLUDED.margin_pct,
                    is_new=EXCLUDED.is_new, on_sale=EXCLUDED.on_sale, specs=EXCLUDED.specs,
                    image=EXCLUDED.image, url=EXCLUDED.url, updated_at=now()"""), {
                "id": p["id"], "title": p["title"], "brand": p.get("brand"),
                "category": p.get("category"), "price": p["price"],
                "old_price": p.get("old_price"), "in_stock": p.get("in_stock", True),
                "rating": p.get("rating", 0), "popularity": p.get("popularity", 0),
                "margin_pct": p.get("margin_pct", 0), "is_new": p.get("is_new", False),
                "on_sale": p.get("on_sale", False),
                "specs": json.dumps(p.get("specs", {}), ensure_ascii=False),
                "image": p.get("image"), "url": p.get("url")})
    s = get_settings()
    meili = AsyncClient(s.meili_url, s.meili_key)
    docs = [{"id": p["id"], "title": p["title"], "brand": p.get("brand"),
             "category": p.get("category"), "price": p["price"],
             "in_stock": p.get("in_stock", True),
             "specs_text": " ".join(f"{k} {v}" for k, v in (p.get("specs") or {}).items())}
            for p in products]
    await meili.index(INDEX).add_documents(docs)
    return len(products)
