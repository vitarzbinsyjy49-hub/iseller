"""Authoritative facts (v5.1): коммерческие данные пользователю — только из БД.

LLM может написать в свободном тексте что угодно («отдам за 10 рублей»).
Карточки и так собираются из БД, но текст тоже не имеет права называть
цену/скидку, которой нет в каталоге. Здесь — фильтр денежных утверждений:
каждое найденное денежное значение сверяется с ценами переданных товаров;
предложение с неподтверждённой суммой удаляется целиком.
"""
import re

from app.models.product import Product

# «119 990 ₽», «119990 руб», «10 рублей», «120 тыс ₽», «за 90к»
_MONEY_RE = re.compile(
    r"(?P<num>\d[\d\s .,]{0,12}?)\s*(?P<suf>тыс\w*|к\b|k\b)?\s*(?:₽|руб\w*|р\.)"
    r"|(?P<num2>\d[\d\s ]{0,9})\s*(?P<suf2>тыс\w*)",
    re.IGNORECASE,
)

_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

NEUTRAL_FALLBACK = "Подобрал варианты — цены и наличие смотрите в карточках ниже."


def _to_amount(num: str, suffix: str | None) -> float | None:
    raw = num.replace(" ", "").replace(" ", "").replace(",", ".")
    try:
        value = float(raw)
    except ValueError:
        return None
    if suffix:
        value *= 1000
    return value


def _allowed_amounts(products: list[Product]) -> set[int]:
    """Все суммы, которые можно упоминать: цены/старые цены/выгода по товарам."""
    allowed: set[int] = set()
    for p in products:
        price = int(float(p.price))
        allowed.add(price)
        if p.old_price is not None:
            old = int(float(p.old_price))
            allowed.add(old)
            allowed.add(old - price)  # «выгода N ₽»
    # разговорные тысячи: 119990 -> допускаем и «120 тысяч» (округление до тыс)
    for a in list(allowed):
        allowed.add(round(a / 1000) * 1000)
    return allowed


def _amount_ok(value: float, allowed: set[int]) -> bool:
    v = int(round(value))
    return v in allowed or v + 1 in allowed or v - 1 in allowed


def sanitize_money_claims(text: str, products: list[Product]) -> tuple[str, int]:
    """Удаляет предложения с денежными суммами, которых нет в БД.

    Возвращает (очищенный текст, сколько предложений удалено).
    Если после чистки не осталось ничего — нейтральная замена.
    """
    if not text.strip():
        return text, 0
    allowed = _allowed_amounts(products)
    sentences = _SENT_SPLIT_RE.split(text)
    kept: list[str] = []
    removed = 0
    for sentence in sentences:
        bad = False
        for m in _MONEY_RE.finditer(sentence):
            num = m.group("num") or m.group("num2")
            suf = m.group("suf") or m.group("suf2")
            amount = _to_amount(num, suf)
            if amount is not None and not _amount_ok(amount, allowed):
                bad = True
                break
        if bad:
            removed += 1
        else:
            kept.append(sentence)
    cleaned = " ".join(s.strip() for s in kept if s.strip()).strip()
    if not cleaned:
        cleaned = NEUTRAL_FALLBACK
    return cleaned, removed
