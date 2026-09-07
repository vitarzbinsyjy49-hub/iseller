"""Реферальная программа: код, связь, выплаты.

Правила живут ЗДЕСЬ, а не в loyalty.record(): record остаётся примитивом
журнала, который умеет провести операцию и больше ничего не знает. Благодаря
этому выплата не может вызвать сама себя — триггером служит только
kind='purchase', а сама выплата имеет kind='referral'.

Один уровень вверх и никаких цепочек: если A привёл B, а B привёл C, то с
покупки C получает только B. Многоуровневость — это пирамида.
"""
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.telegram_bot import AD_SLUG_ALPHABET, REF_CODE_LENGTH

_ALPHABET = "".join(sorted(AD_SLUG_ALPHABET))


def _new_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(REF_CODE_LENGTH))


def code_for(db: Session, user: User) -> str:
    """Код человека, создавая его при первом обращении.

    Коллизия ловится уникальным индексом и вызывает повторную генерацию, а не
    проверкой «сначала посмотрим»: последняя — гонка.
    """
    if user.referral_code:
        return user.referral_code
    for _ in range(5):
        candidate = _new_code()
        user.referral_code = candidate
        try:
            with db.begin_nested():
                db.flush()
        except Exception:
            user.referral_code = None
            continue
        db.commit()
        return candidate
    raise RuntimeError("Не удалось выдать реферальный код: пять коллизий подряд")


def user_by_code(db: Session, code: str) -> User | None:
    if not code:
        return None
    return db.execute(
        select(User).where(User.referral_code == code)
    ).scalar_one_or_none()
