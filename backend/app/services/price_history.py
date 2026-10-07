"""Запись истории цен одним слушателем сессии.

Почему слушатель, а не функция set_price(): цену меняют админка сайта, импорт
(import_center), скрипты сверки BSA и Mini App. Функцию в каждом из них пришлось
бы не забыть вызвать, и первый же новый путь ушёл бы мимо истории. Слушатель
before_flush видит ЛЮБОЕ изменение Product.price в любой сессии процесса.

Кто и откуда менял — подсказывает вызывающий код через session.info:

    attribute(db, actor="tg:8614709711", source="staff")

Без подсказки строка всё равно пишется — с actor=system, source=unknown.
"""
from __future__ import annotations

from sqlalchemy import event
from sqlalchemy.orm import Session, attributes

from app.models.price_change import PriceChange

ACTOR_KEY = "price_actor"
SOURCE_KEY = "price_source"
NOTE_KEY = "price_note"


def attribute(session: Session, *, actor: str, source: str, note: str | None = None) -> None:
    """Подписать следующие изменения цен в этой сессии."""
    session.info[ACTOR_KEY] = actor
    session.info[SOURCE_KEY] = source
    if note is None:
        session.info.pop(NOTE_KEY, None)
    else:
        session.info[NOTE_KEY] = note[:300]


def _as_number(value) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@event.listens_for(Session, "before_flush")
def _record_price_changes(session: Session, _flush_context, _instances) -> None:
    from app.models.product import Product  # здесь, а не наверху: product импортирует этот модуль

    for obj in list(session.dirty):
        if not isinstance(obj, Product) or obj.id is None:
            continue
        hist = attributes.get_history(obj, "price")
        if not hist.has_changes():
            continue
        old = _as_number(hist.deleted[0]) if hist.deleted else None
        new = _as_number(hist.added[0]) if hist.added else None
        if new is None or old == new:
            continue
        session.add(PriceChange(
            product_id=obj.id, old_price=old, new_price=new,
            actor=session.info.get(ACTOR_KEY, "system"),
            source=session.info.get(SOURCE_KEY, "unknown"),
            note=session.info.get(NOTE_KEY),
        ))
