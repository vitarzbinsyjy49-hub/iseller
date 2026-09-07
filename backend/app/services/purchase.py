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
from app.services import loyalty


def purchase_key(lead_id: int, seq: int) -> str:
    return f"lead_{lead_id}_{seq}_purchase"


def accrue_for_lead(db: Session, lead: Lead, actor: str) -> None:
    """Провести кэшбек покупателю по завершённой заявке.

    Молча ничего не делает, если покупателя нет в системе: заявку мог завести
    менеджер вручную, и это норма.
    """
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
