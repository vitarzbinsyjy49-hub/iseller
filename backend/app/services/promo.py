"""Промокоды: проверка, размер скидки и списание.

Одно правило определяет здесь всё остальное: **проверка кода купон не тратит**.
Тратит только оформление заявки, и списание живёт в ТОЙ ЖЕ транзакции, что и
заявка (см. ``services/cart.checkout``). Иначе зашедший «попробовать» сжигал бы
акцию, ничего не купив, а сорвавшееся оформление уносило бы купон с собой.

Расход считается из журнала ``promo_redemptions``, а не из счётчика на коде:
денормализованная копия агрегата расходится молча (тот же урок, что с балансом
баллов).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.promo import MAX_CODE_LENGTH, PromoCode, PromoRedemption

#: Буквы, цифры, дефис и подчёркивание. Пробел внутри кода — почти всегда
#: случайность копирования, а не часть кода.
_CODE_RE = re.compile(r"^[A-Z0-9_-]+$")


class PromoError(ValueError):
    """Код применить нельзя — текст исключения показывается покупателю."""


@dataclass(frozen=True)
class PromoOffer:
    """Что даст код на этой корзине. Возвращается проверкой, ничего не тратит."""

    promo: PromoCode
    discount: float
    total_after: float

    @property
    def code(self) -> str:
        return self.promo.code


def normalize_code(raw: str) -> str:
    """Код к каноническому виду. Человек набирает «start20» и « START20 »,
    имея в виду одно и то же."""
    text = (raw or "").strip().upper()
    if not text:
        raise PromoError("Введите промокод")
    if len(text) > MAX_CODE_LENGTH:
        raise PromoError("Такого промокода не существует")
    if not _CODE_RE.match(text):
        raise PromoError("В промокоде только латиница, цифры и дефис")
    return text


def used_count(db: Session, promo_id: int) -> int:
    """Сколько раз кодом уже воспользовались. Источник — журнал."""
    return int(
        db.execute(
            select(func.count(PromoRedemption.id)).where(PromoRedemption.promo_id == promo_id)
        ).scalar_one()
    )


def _money(value: float | None) -> str:
    return f"{round(float(value or 0)):,}".replace(",", " ") + " ₽"


def _is_expired(promo: PromoCode, now: datetime) -> bool:
    if promo.expires_at is None:
        return False
    expires = promo.expires_at
    # Наивную дату из SQLite считаем UTC: сравнивать naive с aware нельзя, а
    # падать на этом в момент оформления заявки — тем более.
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires < now


def find(db: Session, code: str, *, lock: bool = False) -> PromoCode | None:
    """Код по значению. ``lock=True`` берёт строку под блокировку — нужно на
    списании, чтобы два одновременных оформления не забрали последний купон.

    На SQLite (тесты) блокировка строк не поддерживается и запрос выполняется
    как обычный; настоящую защиту даёт Postgres в проде плюс уникальный индекс
    на паре (код, покупатель), который работает везде.
    """
    stmt = select(PromoCode).where(PromoCode.code == code)
    if lock and db.bind is not None and db.bind.dialect.name != "sqlite":
        stmt = stmt.with_for_update()
    return db.execute(stmt).scalars().first()


def validate(db: Session, raw_code: str, *, user_id: int, order_total: float) -> PromoOffer:
    """Можно ли применить код к этой корзине. НИЧЕГО не тратит и не пишет.

    Причина отказа возвращается текстом для человека: «код не работает» без
    объяснения заставляет писать менеджеру, а это и есть та работа, которую
    промокод должен был сэкономить.
    """
    code = normalize_code(raw_code)
    promo = find(db, code)
    # Несуществующий и выключенный код отвечают ОДИНАКОВО. Разные ответы
    # превращают форму в проверялку чужих кодов: по разнице текстов подбирается
    # список действующих акций.
    if promo is None or not promo.is_active:
        raise PromoError("Такой промокод не найден или больше не действует")

    if _is_expired(promo, datetime.now(timezone.utc)):
        raise PromoError("Срок действия промокода истёк")

    if promo.min_order_amount is not None and order_total < float(promo.min_order_amount):
        raise PromoError(f"Промокод действует от {_money(promo.min_order_amount)}")

    if _already_used(db, promo.id, user_id):
        raise PromoError("Вы уже применяли этот промокод")

    if promo.max_redemptions is not None and used_count(db, promo.id) >= promo.max_redemptions:
        raise PromoError("Промокод закончился — все купоны разобрали")

    discount = discount_for(promo, order_total)
    return PromoOffer(promo=promo, discount=discount, total_after=round(order_total - discount, 2))


def discount_for(promo: PromoCode, order_total: float) -> float:
    """Размер скидки на этой сумме. Ниже нуля корзина не уходит: скидка
    больше корзины — это подарок сверх покупки, а такого мы не обещали."""
    return round(min(float(promo.discount_amount), max(0.0, float(order_total))), 2)


def _already_used(db: Session, promo_id: int, user_id: int) -> bool:
    return db.execute(
        select(PromoRedemption.id).where(
            PromoRedemption.promo_id == promo_id, PromoRedemption.user_id == user_id
        )
    ).first() is not None


def redeem(
    db: Session, promo: PromoCode, *, user_id: int, lead_id: int | None,
    discount: float, order_total: float,
) -> PromoRedemption:
    """Списать купон. Вызывается ТОЛЬКО из оформления заявки и НЕ коммитит:
    строка обязана уехать той же транзакцией, что и сама заявка. Иначе купон
    спишется у сорвавшегося оформления либо заявка пройдёт мимо расхода.
    """
    if promo.max_redemptions is not None and used_count(db, promo.id) >= promo.max_redemptions:
        raise PromoError("Промокод закончился — все купоны разобрали")

    row = PromoRedemption(
        promo_id=promo.id,
        user_id=user_id,
        lead_id=lead_id,
        discount_amount=discount,
        order_total=order_total,
    )
    try:
        # Вложенная транзакция: повтор ловим ОТКАТОМ ДО SAVEPOINT, а не
        # проверкой «сначала посмотрим» — между проверкой и вставкой помещается
        # второй запрос. Уникальность держит БД.
        with db.begin_nested():
            db.add(row)
    except IntegrityError as exc:
        raise PromoError("Вы уже применяли этот промокод") from exc
    return row
