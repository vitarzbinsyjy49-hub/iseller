"""Завершённая заявка как факт покупки.

Прежний запрет «автоматики на статусе заявки нет» (docs/context/cart-and-loyalty.md)
касался статуса «заявка создана» и остаётся в силе: человек нажал кнопку, платить
не за что. Здесь основание другое — терминальный статус ВМЕСТЕ с итоговой суммой,
которую подтвердил менеджер. Оценочный estimated_total не используется нигде.

Ключи идемпотентности включают номер попытки завершения (Lead.completion_seq):
без него сценарий «завершили -> откатили -> завершили снова» вернул бы старую
операцию вместо новой и не начислил бы ничего, не сказав об этом ни словом.
"""
from sqlalchemy.orm import Session

from app.models.lead import Lead
from app.services import loyalty, referral, settings


def purchase_key(lead_id: int, seq: int) -> str:
    return f"lead_{lead_id}_{seq}_purchase"


def accrue_for_lead(db: Session, lead: Lead, actor: str) -> None:
    """Провести кэшбек покупателю по завершённой заявке.

    Молча ничего не делает, если покупателя нет в системе: заявку мог завести
    менеджер вручную, и это норма.
    """
    # Рубильник гасит ВСЮ автоматику, включая кэшбек покупателю. Ручное
    # начисление из карточки клиента продолжает работать — это путь отхода,
    # если механика поведёт себя не так, как ожидалось.
    if not settings.loyalty(db).auto_accrual_enabled:
        return
    if lead.user_id is None or lead.final_total is None:
        return
    loyalty.record(
        db,
        user_id=lead.user_id,
        kind="purchase",
        amount=lead.final_total,
        comment=f"Заявка {lead.id} завершена",
        created_by=actor,
        idempotency_key=purchase_key(lead.id, lead.completion_seq or 0),
    )
    # Выплаты идут ПОСЛЕ покупки: признак первой покупки считается по журналу,
    # в котором она уже есть.
    referral.payout_for_lead(db, lead, actor=actor)


def revert_for_lead(db: Session, lead: Lead, actor: str) -> None:
    """Откатить всё, что начислено по заявке на текущей попытке завершения.

    Корректировке разрешён минус (см. loyalty.record): если баллы успели
    потратить, запрет сделал бы откат невозможным ровно тогда, когда он нужен.
    """
    seq = lead.completion_seq or 0
    key = purchase_key(lead.id, seq)
    original = loyalty.transaction_by_key(db, key)
    # Раннего выхода здесь нет намеренно: реферальные выплаты откатываются
    # независимо от кэшбека. Покупателя могло не быть в системе вовсе, а другу
    # его пригласивший уже получил процент.
    if original is not None:
        _revert_purchase(db, lead, original, key, actor)
    referral.revert_for_lead(db, lead, actor=actor)


def _revert_purchase(db: Session, lead: Lead, original, key: str, actor: str) -> None:
    loyalty.record(
        db,
        user_id=original.user_id,
        kind="correction",
        points=-original.points,
        # Вместе с баллами снимается и оборот: уровень не имеет права остаться
        # купленным сделкой, которая не состоялась.
        amount=-original.amount if original.amount is not None else None,
        comment=f"Заявка {lead.id} вышла из статуса «завершена»",
        created_by=actor,
        idempotency_key=f"{key}_revert",
    )
