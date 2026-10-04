"""Новинки: какая модель свежая — решает система, а не ручной флаг.

Спека: docs/superpowers/specs/2026-10-04-novelty-ranking-and-ai-design.md.

Почему не руками. `is_new` ставили в админке и никогда не снимали: на проде
04.10 он стоял у 307 из 488 товаров, включая 200 из стартового импорта 20.07, —
флаг ничего не значил, и ИИ на «что нового из телефонов» называл iPhone 17
«текущим флагманом» при 64 iPhone 18 в наличии.

Определение: **новинка — модель, впервые появившаяся в каталоге не раньше
`NOVELTY_WINDOW_DAYS` дней назад.**

- «Модель» — семейство вариантов, ТО ЖЕ, по которому витрина склеивает
  карточки (services/variants): сохранённый `family_key`, а где его нет —
  правила линеек. Именно правила, а не «без family_key — сам себе модель»:
  товары из админки и Import Center приходят без `family_key`, и новый цвет
  iPhone 17, заведённый руками, иначе стал бы «новинкой» и поехал наверх.
  Товар, который не склеивается ни с чем, — сам себе модель.
- Витринный образец (суффикс семейства) — та же модель: уценённый iPhone 17,
  заведённый вчера, новинкой не является.
- «Впервые появилась» — min(created_at) по ВСЕМ товарам модели, включая
  выключенные: снятый и вернувшийся вариант не делает модель новой.

Дата хранится в `products.model_first_seen_at` (одна у всех вариантов), флаг
`is_new` выводится из неё. Ступень ранжирования (services/ranking) смотрит на
дату напрямую, флаг нужен витрине (бейдж, секция «Новинки»), рекомендациям и
ИИ. Ручное продвижение старого товара — `promo_boost`.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.product import Product

logger = logging.getLogger("techshop.novelty")


def window_days() -> int:
    """Окно новизны в днях. Читается при каждом вызове, а не один раз при
    импорте: правка .env и monkeypatch в тестах должны действовать сразу."""
    return max(0, int(settings.NOVELTY_WINDOW_DAYS))


def as_utc(value: datetime | None) -> datetime | None:
    """sqlite (тесты) отдаёт даты без пояса, Postgres — с поясом. Сравнивать
    их между собой Python не даёт, поэтому всё приводим к UTC."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def novelty_cutoff(now: datetime | None = None) -> datetime:
    """Граница окна: модель, впервые замеченная не раньше неё, — новинка."""
    return (as_utc(now) or datetime.now(timezone.utc)) - timedelta(days=window_days())


def model_key(product: Product) -> str:
    """Ключ модели товара — см. docstring модуля."""
    # Импорт ленивый: variants тянет правила линеек и разбор регионов, а этот
    # модуль импортирует модель товара — так не возникает цикла при загрузке.
    from app.services.family_rules import SHOWCASE_SUFFIX
    from app.services.variants import family_of

    # Сохранённое семейство главнее правил, даже без осей варианта: family_of
    # без осей отдаёт решение правилам, а ручная правка в админке — это и есть
    # ответ на вопрос «какая это модель».
    family = (product.family_key or "").strip() or family_of(product)
    if not family:
        return f"#{product.id}"
    if family.endswith(SHOWCASE_SUFFIX):
        family = family[: -len(SHOWCASE_SUFFIX)]
    return family


def sync_novelty(db: Session, family_keys: set[str] | None = None,
                 now: datetime | None = None) -> int:
    """Пересчитать `model_first_seen_at` и `is_new`. Возвращает число
    изменённых строк; повторный вызов без изменений каталога вернёт 0.

    `family_keys` — ключи моделей (`model_key`), которые надо выровнять; None —
    весь каталог. Ограничивает только ЗАПИСЬ: чтобы найти первую дату модели,
    читаются все товары — семейство может определяться правилами по названию,
    и отфильтровать его в SQL нельзя.

    Цена: один SELECT по каталогу (сотни строк) и UPDATE только изменившихся
    строк одним сбросом сессии; в установившемся режиме это ноль-несколько
    строк в час. Коммитит сам — вызывается из старта, цикла бота и после
    правок в админке, где транзакция товара уже закрыта.
    """
    products = db.execute(select(Product)).scalars().all()
    keys = {p.id: model_key(p) for p in products}

    first_seen: dict[str, datetime] = {}
    for p in products:
        created = as_utc(p.created_at)
        if created is None:
            continue
        k = keys[p.id]
        if k not in first_seen or created < first_seen[k]:
            first_seen[k] = created

    cutoff = novelty_cutoff(now)
    changed = 0
    for p in products:
        k = keys[p.id]
        if family_keys is not None and k not in family_keys:
            continue
        seen = first_seen.get(k)
        fresh = seen is not None and seen >= cutoff
        if as_utc(p.model_first_seen_at) != seen or bool(p.is_new) != fresh:
            p.model_first_seen_at = seen
            p.is_new = fresh
            changed += 1
    if changed:
        db.commit()
    return changed


def keys_for(products) -> set[str]:
    """Ключи моделей набора товаров — для точечного `sync_novelty`."""
    return {model_key(p) for p in products if p is not None}


def refresh_novelty(db: Session, family_keys: set[str] | None = None) -> None:
    """`sync_novelty` для запросов админки и импорта: без права уронить сам запрос.

    Товар к этому моменту уже сохранён. Сбой пересчёта — повод для строки в
    логе, а не для 500 на «Сохранить»: через час цикл бота выровняет всё сам.
    """
    try:
        sync_novelty(db, family_keys)
    except Exception:  # noqa: BLE001 — новизна вспомогательна, товар уже сохранён
        db.rollback()
        logger.exception("пересчёт новизны не удался (выровняет цикл бота)")


def is_fresh(product: Product, now: datetime | None = None) -> bool:
    """Свежа ли модель товара прямо сейчас — по дате, а не по флагу: флаг
    выравнивается раз в час, дата точна всегда."""
    seen = as_utc(getattr(product, "model_first_seen_at", None))
    return seen is not None and seen >= novelty_cutoff(now)


def novelty_until(product: Product) -> date | None:
    """Последний день, когда модель ещё новинка; None — дата ещё не посчитана."""
    seen = as_utc(getattr(product, "model_first_seen_at", None))
    if seen is None:
        return None
    return (seen + timedelta(days=window_days())).date()


# ---------------------------------------------------------------- слова запроса

#: Слова «хочу новое». У «нов» корень короткий, и голый префикс поймал бы
#: «Новосибирск» и «Новгород», поэтому окончания перечислены явно. Остальные
#: корни длинные и однозначные — им хватает границы слова в начале.
_NOVELTY_RE = re.compile(
    r"\bнов(?:ый|ая|ое|ые|ого|ой|ому|ую|ым|ыми|ых|ом|ее|ей|ейш\w*|еньк\w*|инк\w*|инок|ичк\w*)\b"
    r"|\bпоследн\w*"
    r"|\bсвеж\w*"
    r"|\bвышл\w*|\bвышед\w*|\bвышел\b"
    r"|\b(?:new|newest|latest)\b",
    re.IGNORECASE,
)


def prefers_new(text: str | None) -> bool:
    """Просит ли человек новое: «что нового», «последний айфон», «свежие».

    Текущий год тоже считается («айфон 2026»): число берётся из часов, а не
    вписывается в код, иначе через год правило молча устарело бы.
    """
    if not text:
        return False
    if _NOVELTY_RE.search(text):
        return True
    return _year_re().search(text) is not None


def _year_re() -> re.Pattern:
    return re.compile(rf"\b{datetime.now(timezone.utc).year}\b")


def strip_novelty_words(text: str | None) -> str:
    """Запрос без слов про новизну: «новый айфон 17» -> « айфон 17». Остаток
    показывает, названа ли конкретная модель — тогда «новый» значит состояние
    («не б/у»), а не просьбу о новинке."""
    return _year_re().sub(" ", _NOVELTY_RE.sub(" ", text or ""))
