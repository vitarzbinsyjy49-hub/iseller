from fastapi import APIRouter, Depends, Header, HTTPException, Request
from .schemas import (ChatRequest, RecommendRequest, CompareRequest, SearchRequest,
                      FeedbackRequest, PurchaseEvent)
from ..config import get_settings
from ..core import recommender

router = APIRouter()


def check_key(x_api_key: str = Header(default="")):
    if x_api_key != get_settings().ai_engine_api_key:
        raise HTTPException(401, "Invalid API key")


@router.post("/chat", dependencies=[Depends(check_key)])
async def chat(req: ChatRequest, request: Request):
    """Главная точка: свободный вопрос -> текст + карточки + кнопки."""
    return await request.app.state.pipeline.run(req.user_id, req.message)


@router.post("/recommend", dependencies=[Depends(check_key)])
async def recommend(req: RecommendRequest, request: Request):
    parts = ["подбери", req.category or "товар"]
    if req.use_case: parts.append(f"для {req.use_case}")
    if req.budget_max: parts.append(f"до {req.budget_max} рублей")
    return await request.app.state.pipeline.run(req.user_id, " ".join(parts))


@router.post("/compare", dependencies=[Depends(check_key)])
async def compare(req: CompareRequest, request: Request):
    from sqlalchemy import text
    app = request.app
    async with app.state.engine.connect() as c:
        rows = (await c.execute(text("SELECT title FROM products WHERE id = ANY(:ids)"),
                                {"ids": req.product_ids})).scalars().all()
    if len(rows) < 2:
        raise HTTPException(404, "Products not found")
    q = "сравни " + " и ".join(rows)
    return await app.state.pipeline.run(req.user_id, q)


@router.post("/search", dependencies=[Depends(check_key)])
async def search(req: SearchRequest, request: Request):
    """Чистый поиск без LLM — быстро и бесплатно (для строки поиска Mini App)."""
    app = request.app
    found = await app.state.retriever.search(req.query, req.filters, limit=30)
    profile = await app.state.memory.get_profile(req.user_id)
    top = recommender.rank(found, profile, get_settings().max_products_to_llm)
    from ..core.response_builder import product_card
    return {"cards": [product_card(p) for p in top]}


@router.get("/history/{user_id}", dependencies=[Depends(check_key)])
async def history(user_id: str, request: Request, limit: int = 20):
    return {"items": await request.app.state.memory.history(user_id, limit)}


@router.post("/feedback", dependencies=[Depends(check_key)])
async def feedback(req: FeedbackRequest, request: Request):
    await request.app.state.analytics.feedback(req.analytics_id, req.user_id,
                                               req.rating, req.comment)
    return {"ok": True}


@router.post("/events/purchase", dependencies=[Depends(check_key)])
async def purchase(req: PurchaseEvent, request: Request):
    """Вебхук от вашего бэкенда: покупка после ответа AI -> конверсия в аналитике."""
    if req.analytics_id:
        await request.app.state.analytics.mark_converted(req.analytics_id)
    return {"ok": True}


@router.post("/admin/sync-catalog", dependencies=[Depends(check_key)])
async def sync(request: Request):
    from ..connectors.catalog_sync import sync_catalog
    from ..connectors.http_impl import HttpCatalogConnector
    n = await sync_catalog(request.app.state.engine, HttpCatalogConnector())
    return {"synced": n}


@router.get("/admin/dashboard", dependencies=[Depends(check_key)])
async def dashboard(request: Request, days: int = 7):
    """Данные для раздела AI в вашей админке."""
    return await request.app.state.analytics.dashboard(days)


@router.get("/health")
async def health():
    return {"status": "ok"}
