"""Authoritative facts (v5.1.1): коммерческие данные пользователю — только из БД.

Политика ужесточена против v5.1: system prompt v2 УЖЕ запрещает модели называть
цены, поэтому whitelist «сумма совпала с ценой кандидата» больше не используется —
он позволял приписать цену одного товара другому. Теперь из текста LLM удаляется
ЛЮБОЕ предложение с денежным утверждением; точные цены пользователь видит только
в карточках, которые backend собирает из БД.

Не считаются деньгами обычные характеристики и названия моделей:
«iPhone 16 Pro 256 GB», «16 GB RAM», «M4 Pro», «экран 4K».
"""
import re

NEUTRAL_FALLBACK = "Подобрал варианты — цены и наличие смотрите в карточках ниже."

# --- Деньги по валютному маркеру: «10 ₽», «10 руб», «10 рублей», «10 р.», «10 000 ₽»
_CURRENCY_RE = re.compile(
    r"\d[\d\s  .,]*\s*(?:₽|руб\w*|р\.(?:\s|$))",
    re.IGNORECASE,
)

# --- Деньги по суффиксу тысяч: «10 тыс», «10 тысяч», «10к», «10k».
# Порог >=10 отсекает характеристики дисплея «4K»/«8K».
_THOUSANDS_RE = re.compile(r"(\d[\d\s  ]*)\s*(?:тыс\w*|[кk])(?![a-zа-яё])", re.IGNORECASE)

# --- Деньги по контексту: «цена 10 000», «стоит 10 000», «отдам за 10 000»,
# «скидка 10 000», «выгода 10 000», «дешевле/дороже на 10 000», «обойдётся в 10 000»
_CONTEXT_RE = re.compile(
    r"(?:цен[аоыу]\w*|сто[ий]\w*|стоимост\w*|отдам\s+за|продам\s+за|куп\w+\s+за"
    r"|скидк\w*|выгод\w*|дешевле\s+на|дороже\s+на|обойд\w+\s+в|за\s+вс[её])"
    r"\W{0,8}\d",
    re.IGNORECASE,
)

_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _has_money_claim(sentence: str) -> bool:
    if _CURRENCY_RE.search(sentence):
        return True
    if _CONTEXT_RE.search(sentence):
        return True
    for m in _THOUSANDS_RE.finditer(sentence):
        raw = m.group(1).replace(" ", "").replace(" ", "").replace(" ", "")
        try:
            if int(raw) >= 10:  # «4K»-экран — не деньги, «10к» — деньги
                return True
        except ValueError:
            continue
    return False


def sanitize_money_claims(text: str, _products=None) -> tuple[str, int]:
    """Удаляет предложения с денежными утверждениями из текста LLM.

    _products оставлен в сигнатуре для совместимости, но НЕ используется:
    никакой whitelist цен (v5.1.1). Возвращает (очищенный текст, удалено предложений).
    """
    if not text.strip():
        return text, 0
    sentences = _SENT_SPLIT_RE.split(text)
    kept = [s for s in sentences if not _has_money_claim(s)]
    removed = len(sentences) - len(kept)
    cleaned = " ".join(s.strip() for s in kept if s.strip()).strip()
    if not cleaned:
        cleaned = NEUTRAL_FALLBACK
    return cleaned, removed
