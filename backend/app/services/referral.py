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
from app.services import loyalty, settings
from app.services.notification_templates import referral_payout_message
from app.services.notifications import enqueue, notifications_enabled
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


# ---------------------------------------------------------------- выплаты


def referral_key(lead_id: int, seq: int) -> str:
    return f"lead_{lead_id}_{seq}_referral"


def welcome_key(lead_id: int, seq: int) -> str:
    return f"lead_{lead_id}_{seq}_welcome"


def payout_for_lead(db: Session, lead, actor: str) -> None:
    """Выплаты по завершённой сделке приглашённого.

    Вызывается ПОСЛЕ проведения покупки: признак первой покупки считается по
    журналу, в котором она уже есть.
    """
    buyer = db.get(User, lead.user_id) if lead.user_id else None
    if buyer is None or buyer.referred_by_user_id is None:
        return

    conf = settings.loyalty(db)
    seq = lead.completion_seq or 0

    points = payout_points(lead.final_total, conf.referral_rate_bps)
    if points > 0:
        loyalty.record(
            db,
            user_id=buyer.referred_by_user_id,
            kind="referral",
            points=points,
            rate_bps=conf.referral_rate_bps,
            comment=f"{conf.referral_rate_bps / 100:g}% с покупки приглашённого (заявка {lead.id})",
            created_by=actor,
            idempotency_key=referral_key(lead.id, seq),
        )
        _notify_inviter(db, lead, seq, points)

    if conf.welcome_bonus_points > 0 and is_first_purchase(db, buyer.id):
        loyalty.record(
            db,
            user_id=buyer.id,
            kind="referral",
            points=conf.welcome_bonus_points,
            comment="Приветственные баллы за первую покупку по приглашению",
            created_by=actor,
            idempotency_key=welcome_key(lead.id, seq),
        )


def revert_for_lead(db: Session, lead, actor: str) -> None:
    """Отменить выплаты по заявке, вышедшей из статуса «завершена»."""
    seq = lead.completion_seq or 0
    for key in (referral_key(lead.id, seq), welcome_key(lead.id, seq)):
        original = loyalty.transaction_by_key(db, key)
        if original is None:
            continue
        loyalty.record(
            db,
            user_id=original.user_id,
            kind="correction",
            points=-original.points,
            comment=f"Заявка {lead.id} вышла из статуса «завершена»",
            created_by=actor,
            idempotency_key=f"{key}_revert",
        )


def _notify_inviter(db: Session, lead, seq: int, points: int) -> None:
    """Сообщить пригласившему о начислении.

    Сети здесь нет: строка уходит в outbox той же транзакцией, что и сама
    выплата, — та же схема, что у статусов заявки. dedupe_key привязан к заявке
    И попытке завершения: повторное сохранение статуса второго сообщения не
    породит, а начисление заново после отката — породит.
    """
    if not notifications_enabled():
        return
    inviter = db.get(User, lead.user_id).referred_by_user_id if lead.user_id else None
    chat = db.get(User, inviter).telegram_id if inviter else None
    enqueue(
        db,
        chat_id=chat,
        kind="referral_payout",
        message=referral_payout_message(points=points),
        dedupe_key=f"referral:{lead.id}:{seq}",
    )
