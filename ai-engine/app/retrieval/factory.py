from app.config import get_settings
from app.retrieval.base import Retriever
from app.retrieval.meili import MeilisearchRetriever
from app.retrieval.postgres import PostgresRetriever

_REGISTRY = {"postgres": PostgresRetriever, "pgvector": PostgresRetriever,
             "meilisearch": MeilisearchRetriever}


def get_retriever() -> Retriever:
    return _REGISTRY[get_settings().search_backend.lower()]()
