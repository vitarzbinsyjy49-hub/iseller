"""Правила лояльности: уровни, ставки, баланс, оборот.

Правило живёт в ОДНОМ месте, как и порядок выдачи каталога (``ranking.py``):
лестницу читают админка, витрина и тесты, и второй её копии нигде нет — фронт
получает уровни из API, а не объявляет свои.

Три величины и все три производные от журнала ``loyalty_transactions``:

    balance        = SUM(points)
    lifetime_spent = SUM(amount) WHERE kind = 'purchase'
    level          = последний порог, не превышающий lifetime_spent

Списание оборот НЕ уменьшает: потратил баллы — уровень не упал. Уровень про то,
сколько человек у нас купил, а не сколько у него сейчас на счету.
"""
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.loyalty import COMMENT_REQUIRED, LOYALTY_KINDS, LoyaltyTransaction


class LoyaltyError(ValueError):
    """Нарушение правила лояльности. API отдаёт его как 422."""


@dataclass(frozen=True)
class Level:
    key: str
    title: str
    threshold: int  # оборот за всё время, ₽, от которого действует уровень
    rate_bps: int   # ставка кэшбека в сотых процента: 25 = 0,25%

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "title": self.title,
            "threshold": self.threshold,
            "rate_bps": self.rate_bps,
            "rate_percent": self.rate_bps / 100,
        }


# Пороги в рублях, а не в баллах: рубль понятен человеку, а порог в баллах
# зависел бы от ставки, то есть сам от себя. Первый порог обязан быть нулевым —
# уровень есть у каждого с первого дня.
LEVELS: tuple[Level, ...] = (
    Level("start", "Старт", 0, 25),
    Level("silver", "Серебро", 150_000, 50),
    Level("gold", "Золото", 400_000, 100),
    Level("platinum", "Платина", 800_000, 150),
    Level("black", "Чёрный", 1_500_000, 200),
)

MAX_HISTORY = 100


def level_for(lifetime_spent: float | Decimal) -> Level:
    """Последний уровень, порог которого не выше оборота."""
    spent = Decimal(str(lifetime_spent or 0))
    current = LEVELS[0]
    for level in LEVELS:
        if spent >= level.threshold:
            current = level
        else:
            break
    return current


def next_level(lifetime_spent: float | Decimal) -> Level | None:
    """Следующая ступень или None, если человек на вершине."""
    spent = Decimal(str(lifetime_spent or 0))
    for level in LEVELS:
        if spent < level.threshold:
            return level
    return None


def points_for(amount: float | Decimal, rate_bps: int) -> int:
    """Баллы за покупку. Округление ВНИЗ.

    Вверх дарило бы по баллу на каждой операции, и на длинной истории это
    расхождение с обещанной ставкой, которое никто не сможет объяснить.
    """
    if amount is None or amount <= 0 or rate_bps <= 0:
        return 0
    return int(Decimal(str(amount)) * rate_bps // 10_000)


def progress(lifetime_spent: float | Decimal) -> dict:
    """Уровень, ставка и путь до следующей ступени — для прогресс-бара."""
    spent = Decimal(str(lifetime_spent or 0))
    level = level_for(spent)
    upcoming = next_level(spent)
    if upcoming is None:
        return {
            "level": level.to_dict(),
            "next_level": None,
            "to_next": 0,
            "ratio": 1.0,
        }
    span = upcoming.threshold - level.threshold
    done = spent - level.threshold
    return {
        "level": level.to_dict(),
        "next_level": upcoming.to_dict(),
        "to_next": float(upcoming.threshold - spent),
        "ratio": float(done / span) if span else 0.0,
    }


# ---------------------------------------------------------------- агрегаты


def totals(db: Session, user_ids: list[int]) -> dict[int, dict]:
    """Баланс и оборот пачкой — ОДИН GROUP BY на страницу списка.

    Запрос на строку превратил бы список из сотни клиентов в сотню запросов;
    это тот же приём, что apply_social_proof для карточек.
    """
    if not user_ids:
        return {}
    rows = db.execute(
        select(
            LoyaltyTransaction.user_id,
            func.coalesce(func.sum(LoyaltyTransaction.points), 0),
            # CASE, а не FILTER: FILTER есть не во всех сборках SQLite, на
            # которых гоняются тесты, а расхождение движков в агрегате баланса —
            # последнее место, где хочется его обнаружить.
            func.coalesce(
                func.sum(
                    case(
                        (
                            # Оборот двигают покупки — и корректировки, которыми
                            # покупку отменяют. Иначе уровень, поднятый
                            # несостоявшейся сделкой, оставался бы навсегда, а
                            # вместе с ним и ставка кэшбека: откат вернул бы
                            # баллы, но не то, что они означают.
                            LoyaltyTransaction.kind.in_(("purchase", "correction")),
                            LoyaltyTransaction.amount,
                        ),
                        else_=0,
                    )
                ),
                0,
            ),
        )
        .where(LoyaltyTransaction.user_id.in_(user_ids))
        .group_by(LoyaltyTransaction.user_id)
    ).all()
    found = {
        user_id: {"balance": int(balance or 0), "lifetime_spent": float(spent or 0)}
        for user_id, balance, spent in rows
    }
    # Пользователь без единой операции — не «нет данных», а нулевой счёт на
    # уровне «Старт». Пропуск ключа заставил бы каждого потребителя городить
    # свой запасной вариант.
    return {
        user_id: found.get(user_id, {"balance": 0, "lifetime_spent": 0.0})
        for user_id in user_ids
    }


def summary(db: Session, user_id: int) -> dict:
    """Полная картина по одному пользователю: счёт, уровень, прогресс."""
    base = totals(db, [user_id])[user_id]
    out = dict(base)
    out.update(progress(base["lifetime_spent"]))
    return out


def history(db: Session, user_id: int, limit: int = 50) -> list[dict]:
    limit = max(1, min(limit, MAX_HISTORY))
    rows = db.execute(
        select(LoyaltyTransaction)
        .where(LoyaltyTransaction.user_id == user_id)
        .order_by(LoyaltyTransaction.created_at.desc(), LoyaltyTransaction.id.desc())
        .limit(limit)
    ).scalars().all()
    return [row.to_dict() for row in rows]


def levels_public() -> list[dict]:
    return [level.to_dict() for level in LEVELS]


# ---------------------------------------------------------------- запись


def _existing(db: Session, user_id: int, key: str | None) -> LoyaltyTransaction | None:
    if not key:
        return None
    return db.execute(
        select(LoyaltyTransaction).where(
            LoyaltyTransaction.user_id == user_id,
            LoyaltyTransaction.idempotency_key == key,
        )
    ).scalar_one_or_none()


def transaction_by_key(db: Session, key: str) -> LoyaltyTransaction | None:
    """Операция по ключу идемпотентности.

    Ключ уникален В ПРЕДЕЛАХ пользователя, и приватный ``_existing`` требует
    ``user_id``. Откату он заранее неизвестен: заявка знает номер, а не того,
    кому по ней заплатили. Наши ключи содержат id заявки и номер попытки,
    поэтому глобально они тоже не повторяются.
    """
    return db.execute(
        select(LoyaltyTransaction).where(LoyaltyTransaction.idempotency_key == key)
    ).scalars().first()


def _validate(kind: str, points: int, amount: Decimal | None, comment: str | None) -> None:
    if kind not in LOYALTY_KINDS:
        raise LoyaltyError(f"Неизвестный вид операции: {kind}")
    if points == 0:
        raise LoyaltyError("Операция на ноль баллов не имеет смысла")
    if kind in COMMENT_REQUIRED and not (comment or "").strip():
        raise LoyaltyError("Для списания и корректировки комментарий обязателен")
    if kind == "purchase":
        if amount is None or amount <= 0:
            raise LoyaltyError("У покупки должна быть сумма больше нуля")
        if points < 0:
            raise LoyaltyError("Покупка не может списывать баллы")
    elif kind == "correction":
        # Корректировка — единственный способ отменить покупку, и вместе с
        # баллами она обязана снять оборот: иначе уровень остался бы куплен
        # сделкой, которой не было. Только в минус: наращивать оборот
        # корректировкой значит выдавать уровень руками.
        if amount is not None and amount >= 0:
            raise LoyaltyError("Корректировка может только уменьшать оборот")
    else:
        # Оборот двигают ТОЛЬКО покупки: подарочный бонус, поднимающий уровень,
        # означал бы, что уровень больше не про покупки.
        if amount is not None:
            raise LoyaltyError("Сумма покупки указывается только для операции «покупка»")
    if kind == "spend" and points > 0:
        raise LoyaltyError("Списание должно быть отрицательным")
    if kind == "bonus" and points < 0:
        raise LoyaltyError("Бонус не может быть отрицательным")


def record(
    db: Session,
    *,
    user_id: int,
    kind: str,
    points: int | None = None,
    amount: float | Decimal | None = None,
    comment: str | None = None,
    created_by: str | None = None,
    idempotency_key: str | None = None,
    rate_bps: int | None = None,
) -> LoyaltyTransaction:
    """Провести операцию. Единственный способ изменить счёт.

    Прямого «поставить баланс = N» нет и не будет: баланс — следствие журнала.
    Обнуление проводится корректировкой с комментарием, и через год видно, кто
    и зачем это сделал.
    """
    existing = _existing(db, user_id, idempotency_key)
    if existing is not None:
        # Двойной клик по «Начислить» не имеет права дать двойной кэшбек.
        return existing

    money = Decimal(str(amount)) if amount is not None else None
    current = summary(db, user_id)
    # Ставка покупки берётся из уровня, и перебить её нельзя: она следствие
    # оборота. Для реферальной выплаты ставку задаёт настройка, поэтому она
    # приходит снаружи — но снапшотится точно так же.
    if kind == "purchase":
        rate_bps = current["level"]["rate_bps"]
    elif kind != "referral":
        rate_bps = None
    if points is None:
        # Расчёт предлагается, а не навязывается: менеджер может перебить его
        # руками, передав points явно.
        points = points_for(money, rate_bps) if kind == "purchase" else 0

    _validate(kind, int(points), money, comment)

    # Корректировка — единственный вид, которому минус разрешён. Ею
    # откатывают начисления по сделке, которая не состоялась, и если человек
    # успел потратить баллы, запрет минуса сделал бы откат невозможным ровно
    # тогда, когда он нужен. Отрицательный баланс — штатное состояние: он
    # виден человеку и гасится из будущих начислений.
    if kind != "correction" and current["balance"] + int(points) < 0:
        raise LoyaltyError(
            f"Недостаточно баллов: на счету {current['balance']}, "
            f"списать пытаются {abs(int(points))}"
        )

    row = LoyaltyTransaction(
        user_id=user_id,
        kind=kind,
        points=int(points),
        amount=money,
        rate_bps=rate_bps,
        comment=(comment or "").strip() or None,
        created_by=created_by,
        idempotency_key=idempotency_key,
    )
    db.add(row)
    try:
        # SAVEPOINT: гонку по ключу ловит БД, а не проверка «сначала посмотрим»,
        # и откат не уносит внешнюю транзакцию — тот же приём, что в notifications.
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        db.expunge(row)
        duplicate = _existing(db, user_id, idempotency_key)
        if duplicate is None:
            raise
        return duplicate
    return row
