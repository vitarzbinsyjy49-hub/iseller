"""Отзывы: просьба после сделки, приём, модерация, средняя оценка.

Путь у отзыва один и жёсткий:

    заявка «завершена» -> бот просит оценить -> покупатель заполняет форму
    -> отзыв ждёт модерации -> владелец одобряет -> отзыв на карточке товара

Открытой формы «оставьте отзыв» нет намеренно. Отзыв рождается только из
заявки, поэтому «покупка подтверждена» на витрине — не обещание, а свойство
данных: без заявки строки просто нет.

Сети здесь нет: просьба уходит в тот же outbox уведомлений, что и смена
статуса (services/notifications), и отправляется сервисом бота. Смена статуса
в админке не имеет права ждать Telegram, тем более падать вместе с ним.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.lead import Lead
from app.models.product import Product
from app.models.review import RATING_MAX, RATING_MIN, REVIEW_STATUSES, Review
from app.services.notification_templates import Message
from app.services.notifications import enqueue, notifications_enabled

logger = logging.getLogger("techshop.reviews")

NOTIFY_KIND = "review_request"


class ReviewError(ValueError):
    """Нарушение правила отзывов. API отдаёт как 422."""


def _mini_app(path: str) -> str | None:
    """Абсолютный https-URL экрана Mini App, иначе None.

    Тот же контракт, что у бота: web_app-кнопку без валидного https Telegram
    отвергает вместе со ВСЕМ сообщением, поэтому лучше уведомление без кнопки,
    чем не доставленное уведомление.
    """
    base = (settings.MINI_APP_URL or "").strip().rstrip("/")
    return f"{base}{path}" if base.startswith("https://") else None


def request_message(lead: Lead) -> Message | None:
    """Текст просьбы оценить заказ. None — просить нечего.

    Кнопка тут web_app и это законно: уведомление уходит в ЛИЧНЫЙ чат с ботом,
    а не в канал (в канале Telegram такую кнопку отвергает целиком).
    """
    url = _mini_app(f"/review/{lead.id}")
    what = lead.product_title or (f"{lead.items_count} поз." if lead.items_count else None)
    text = (
        f"Спасибо за покупку! Заявка {lead.public_number} закрыта"
        + (f" — {what}.\n" if what else ".\n")
        + "\nОцените заказ по пятибалльной шкале и, если хотите, приложите фото. "
        "Это займёт минуту и поможет тем, кто выбирает после вас.\n"
        # Просьба про экран на заднем плане — не украшение кадра. Такое фото
        # само доказывает, что отзыв оставил живой покупатель нашего бота, а не
        # взято из интернета. Просим, а не требуем: без фото отзыв тоже примем,
        # иначе половина людей просто не ответит.
        "\n📸 Если не сложно — снимите так, чтобы рядом был экран с нашим ботом "
        "или каналом. Так сразу видно, что отзыв настоящий."
    )
    keyboard = [[{"text": "⭐️ Оценить заказ", "web_app": {"url": url}}]] if url else []
    return Message(text=text, keyboard=keyboard)


def request_for_lead(db: Session, lead: Lead) -> None:
    """Поставить просьбу об отзыве в очередь. НЕ коммитит — как и enqueue.

    Ключ дедупликации включает номер попытки завершения: заявку могут вернуть
    из «завершена» и завершить снова, и тогда просьба уместна ещё раз. Без
    номера повторное завершение молчало бы навсегда.

    Уже оставленный отзыв просьбу отменяет: человек своё дело сделал, второе
    напоминание он прочтёт как невнимательность магазина.
    """
    if not notifications_enabled() or not lead.telegram_id:
        return
    if db.scalar(select(func.count()).select_from(Review).where(Review.lead_id == lead.id)):
        return
    enqueue(
        db,
        chat_id=lead.telegram_id,
        kind=NOTIFY_KIND,
        message=request_message(lead),
        dedupe_key=f"review_request:{lead.id}:{lead.completion_seq or 0}",
    )


def can_review(lead: Lead | None) -> bool:
    """Отзыв можно оставить только по СВОЕЙ завершённой заявке."""
    return bool(lead) and lead.status == "completed"


def submit(
    db: Session, *, lead: Lead, rating: int, text: str | None = None,
    photos: list[str] | None = None, product_id: int | None = None,
    author_name: str | None = None,
) -> Review:
    """Принять отзыв от покупателя. Всегда уходит на модерацию.

    Повторная отправка правит существующий отзыв, а не создаёт второй: у
    заявки один отзыв (уникальный индекс), и человек имеет право передумать,
    пока владелец не одобрил.
    """
    if not can_review(lead):
        raise ReviewError("Отзыв можно оставить только по завершённой заявке")
    if not isinstance(rating, int) or not (RATING_MIN <= rating <= RATING_MAX):
        raise ReviewError(f"Оценка должна быть числом от {RATING_MIN} до {RATING_MAX}")

    clean_photos = [p for p in (photos or []) if isinstance(p, str) and p.strip()][:10]
    row = db.scalar(select(Review).where(Review.lead_id == lead.id))
    if row is None:
        row = Review(lead_id=lead.id, user_id=lead.user_id)
        db.add(row)
    elif row.status == "approved":
        # Одобренный отзыв покупатель уже не правит: он опубликован, и тихая
        # подмена текста под тем же «подтверждено» — это подмена витрины.
        raise ReviewError("Отзыв уже опубликован — напишите менеджеру, если нужно изменить")

    row.rating = rating
    row.text = (text or "").strip() or None
    row.photos = clean_photos
    row.product_id = product_id if product_id is not None else _default_product(db, lead)
    row.author_name = (author_name or lead.name or "").strip()[:120] or None
    row.status = "pending"
    row.moderator_note = None
    return row


def _default_product(db: Session, lead: Lead) -> int | None:
    """Товар отзыва, если покупатель не выбрал сам.

    Порядок: сначала то, что менеджер отметил как КУПЛЕННОЕ по факту
    (`purchased_product_id`) — человек мог прийти за одними наушниками, а взять
    другие, и отзыв должен висеть на том, что он реально унёс. Дальше — товар
    заявки. Заявка-корзина без явного выбора — ничего: угадать, о какой из пяти
    позиций отзыв, нельзя, а приписать его случайной значит соврать на
    карточке. Такой отзыв живёт в общей ленте.
    """
    if lead.purchased_product_id:
        return lead.purchased_product_id
    if lead.product_id:
        return lead.product_id
    from app.models.lead_item import LeadItem

    ids = db.scalars(select(LeadItem.product_id).where(LeadItem.lead_id == lead.id)).all()
    unique = {i for i in ids if i}
    return unique.pop() if len(unique) == 1 else None


def moderate(db: Session, review: Review, *, status: str, note: str | None = None) -> Review:
    """Одобрить или отклонить. НЕ коммитит."""
    if status not in REVIEW_STATUSES:
        raise ReviewError(f"status должен быть одним из {REVIEW_STATUSES}")
    review.status = status
    review.moderator_note = (note or "").strip() or None
    review.published_at = datetime.now(timezone.utc) if status == "approved" else None
    db.flush()
    if review.product_id:
        recompute_product_rating(db, review.product_id)
    return review


def recompute_product_rating(db: Session, product_id: int) -> float:
    """Средняя оценка товара по ОДОБРЕННЫМ отзывам.

    Пишется в Product.rating — поле существовало с самого начала и до сих пор
    стояло нулём у всех: считать его было не из чего. Теперь у него появился
    источник, и витрина может показывать звёзды, не выдумывая их.
    """
    avg = db.scalar(
        select(func.avg(Review.rating)).where(
            Review.product_id == product_id, Review.status == "approved")
    )
    product = db.get(Product, product_id)
    if product is None:
        return 0.0
    product.rating = round(float(avg), 2) if avg is not None else 0.0
    return product.rating


def approved_for_product(db: Session, product_id: int, *, limit: int = 20) -> list[Review]:
    return list(db.scalars(
        select(Review)
        .where(Review.product_id == product_id, Review.status == "approved")
        .order_by(Review.published_at.desc().nullslast(), Review.id.desc())
        .limit(limit)
    ))


def approved(db: Session, *, limit: int = 50, offset: int = 0) -> list[Review]:
    return list(db.scalars(
        select(Review)
        .where(Review.status == "approved")
        .order_by(Review.published_at.desc().nullslast(), Review.id.desc())
        .offset(offset).limit(limit)
    ))


def summary_for_product(db: Session, product_id: int) -> dict:
    """Сводка для карточки: средняя и сколько. Ноль отзывов — нули, не None:
    витрине проще не рисовать блок по count == 0, чем разбирать пустоту."""
    row = db.execute(
        select(func.avg(Review.rating), func.count(Review.id))
        .where(Review.product_id == product_id, Review.status == "approved")
    ).one()
    avg, count = row[0], row[1] or 0
    return {"rating": round(float(avg), 2) if avg is not None else 0.0, "count": int(count)}
