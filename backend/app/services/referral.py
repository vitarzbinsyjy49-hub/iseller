"""Реферальная программа: код, связь, выплаты.

Правила живут ЗДЕСЬ, а не в loyalty.record(): record остаётся примитивом
журнала, который умеет провести операцию и больше ничего не знает. Благодаря
этому выплата не может вызвать сама себя — триггером служит только
kind='purchase', а сама выплата имеет kind='referral'.

Один уровень вверх и никаких цепочек: если A привёл B, а B привёл C, то с
покупки C получает только B. Многоуровневость — это пирамида.
"""
import secrets
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.loyalty import LoyaltyTransaction
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


# ---------------------------------------------------------------- расчёт


def payout_points(amount: float | Decimal | None, rate_bps: int) -> int:
    """Процент с покупки, округлённый ВНИЗ.

    Ровно тот же расчёт, что у кэшбека (loyalty.points_for), и по той же
    причине вниз: округление вверх дарило бы по баллу на каждой операции.
    """
    if amount is None or amount <= 0 or rate_bps <= 0:
        return 0
    return int(Decimal(str(amount)) * rate_bps // 10_000)


def is_first_purchase(db: Session, user_id: int) -> bool:
    """Первая покупка — ровно одна проведённая операция вида «покупка».

    Считается ПОСЛЕ проведения текущей, поэтому единица, а не ноль.
    """
    count = db.execute(
        select(func.count()).select_from(LoyaltyTransaction).where(
            LoyaltyTransaction.user_id == user_id,
            LoyaltyTransaction.kind == "purchase",
        )
    ).scalar_one()
    return count == 1
