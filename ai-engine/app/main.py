"""AI Engine — автономный сервис. Подключается к основному проекту через REST API."""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine
from .config import get_settings
from .api.routes import router
from .core.pipeline import Pipeline
from .core.retriever import Retriever
from .core.memory import Memory
from .core.cache import Cache
from .analytics.logger import Analytics
from .llm.factory import build_llm


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    engine = create_async_engine(s.database_url, pool_size=10, max_overflow=20)
    retriever = Retriever(engine)
    try:
        await retriever.ensure_index()
    except Exception:
        pass  # Meili поднимется позже — есть SQL-fallback
    app.state.engine = engine
    app.state.retriever = retriever
    app.state.memory = Memory(engine)
    app.state.analytics = Analytics(engine)
    app.state.pipeline = Pipeline(build_llm(), retriever, app.state.memory,
                                  Cache(engine), app.state.analytics)
    yield
    await engine.dispose()


app = FastAPI(title="AI Engine", version="1.0.0",
              description="Автономный AI-модуль для Telegram Mini App магазина техники",
              lifespan=lifespan)
app.include_router(router, prefix="/api/v1")
