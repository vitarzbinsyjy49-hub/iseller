"""Приём прайсов от читателя (tools/tg_reader). Доступ — только по токену."""
import logging
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.services import bsa_fetch, price_reader

router = APIRouter(prefix="/price-ingest", tags=["price-ingest"])
logger = logging.getLogger("techshop.price_ingest")


def reader_auth(x_reader_token: str = Header(default="")) -> None:
    expected = settings.PRICE_READER_TOKEN
    if not expected:
        raise HTTPException(503, "Приём цен от читателя не настроен")
    if not secrets.compare_digest(x_reader_token.encode(), expected.encode()):
        raise HTTPException(401, "Неверный токен")


@router.post("", dependencies=[Depends(reader_auth)])
def ingest(payload: dict, db: Session = Depends(get_db)):
    """{source: bsa|apostl, texts: {id поста: текст}, failed: [id]} -> итог сверки."""
    try:
        return price_reader.accept(db, payload)
    except price_reader.BadPayload as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/ping", dependencies=[Depends(reader_auth)])
def ping():
    """Читатель проверяет токен и связь, ничего не передавая."""
    return {"ok": True}


@router.get("/config", dependencies=[Depends(reader_auth)])
def reader_config():
    """Что читать: номера постов живут здесь, у читателя их копии нет."""
    return {"bsa_posts": sorted({*bsa_fetch.PUBLIC_POSTS, *bsa_fetch.RICH_POSTS}),
            "bsa_titles": ["bsa store", "big sale apple", "bigsaleapple"],
            "apostl_titles": ["apostl", "apostle"]}
