"""Режим доступности товара — единственный источник правды для корзины.

В проекте исторически нет поля «режим доступности»: есть четыре независимых
флага (``is_active``, ``in_stock``, ``stock``, ``is_limited``), и витрина
интерпретировала их каждый раз заново («Под заказ», «Осталось N шт»). Для
корзины этого мало: правила «можно ли добавить», «сколько максимум» и «что
писать пользователю» должны считаться в ОДНОМ месте, иначе backend и фронт
разъедутся, а расхождение здесь означает заявку на товар, которого нет.

Режим выводится из данных. Явная колонка ``products.availability_mode``
необязательна и по умолчанию NULL — тогда поведение ровно то же, что было до
корзины. Заполненная колонка позволяет выразить то, чего флагами сказать
нельзя: «нет и не будет в ближайшее время» (out_of_stock) и «предзаказ»
(preorder). Никакой конвертации существующих товаров нет и не требуется.
"""
from __future__ import annotations

# Порядок — от «есть» к «нет». Значения стабильные: они уезжают в снапшот
# позиции заявки и не должны меняться задним числом.
AVAILABILITY_MODES = (
    "in_stock",      # обычный товар в наличии
    "limited",       # ограниченная партия: количество не выше остатка
    "preorder",      # предзаказ: добавить можно, позиция помечается
    "on_request",    # «под заказ»: наличие подтвердит менеджер
    "out_of_stock",  # нет в наличии: обычное добавление запрещено
    "unavailable",   # снят с публикации/удалён: в заявку попасть не может
)

# Режимы, которые можно положить в корзину и отправить в заявке.
ORDERABLE_MODES = ("in_stock", "limited", "preorder", "on_request")

# Явно задаваемые в админке режимы. ``unavailable`` сюда не входит: скрытие
# товара — это ``is_active=False``, второго выключателя заводить нельзя.
EXPLICIT_MODES = ("in_stock", "limited", "preorder", "on_request", "out_of_stock")

# Потолок количества одной позиции. Не бизнес-правило, а защита от опечатки и
# от подобранного запроса: 999 iPhone в демо-корзине — это не заявка.
MAX_ITEM_QUANTITY = 20

AVAILABILITY_LABEL = {
    "in_stock": "В наличии",
    "limited": "Ограниченная партия",
    "preorder": "Предзаказ",
    "on_request": "Под заказ",
    "out_of_stock": "Нет в наличии",
    "unavailable": "Недоступен",
}

# Что показать пользователю рядом с позицией. Пусто — когда добавлять нечего
# пояснять (обычный товар в наличии).
AVAILABILITY_NOTE = {
    "limited": "Ограниченная партия",
    "preorder": "Предзаказ — сроки подтвердит менеджер",
    "on_request": "Наличие уточнит менеджер",
    "out_of_stock": "Нет в наличии",
    "unavailable": "Товар снят с продажи",
}


#: Что стоит на месте цены у предзаказа. Живёт здесь, а не в вёрстке: цену
#: прячут и карточка в ленте, и деталка, и админка, и подпись обязана быть одна.
#: Пустая строка у всех остальных режимов — признак «цену показывать как есть».
PRICE_NOTE = {
    "preorder": "Цену уточнит менеджер",
}


def price_note(product) -> str:
    """Текст вместо цены, если цену называть нельзя. Пусто — значит можно."""
    return PRICE_NOTE.get(resolve_availability(product), "")


def exclude_preorder(stmt):
    """Убрать из выдачи предзаказы.

    Нужно там, где выдачу читает не человек, а автоматика: AI-подбор не должен
    ни советовать устройство, которого ещё нет в продаже, ни рассказывать его
    характеристики — их никто не проверял. Витрина предзаказ показывает, и это
    разные вопросы, поэтому фильтр отдельный, а не внутри `is_active`.

    `is_distinct_from` (а не `!=`): NULL в колонке означает «режим выводится из
    флагов», и обычное сравнение отбросило бы такой товар вместе с предзаказами.
    """
    from app.models.product import Product
    return stmt.where(Product.availability_mode.is_distinct_from("preorder"))


def resolve_availability(product) -> str:
    """Режим доступности товара.

    ``is_active=False`` перебивает всё: скрытый товар недоступен независимо от
    складских флагов. Дальше — явно заданный режим, и только потом вывод из
    ``in_stock``/``is_limited``. Порядок именно такой: явное значение не должно
    воскрешать снятый с публикации товар.
    """
    if product is None:
        return "unavailable"
    if not getattr(product, "is_active", True):
        return "unavailable"

    explicit = (getattr(product, "availability_mode", None) or "").strip().lower()
    if explicit in EXPLICIT_MODES:
        return explicit

    if not getattr(product, "in_stock", False):
        return "on_request"
    if getattr(product, "is_limited", False):
        return "limited"
    return "in_stock"


def is_orderable(mode: str) -> bool:
    """Можно ли положить товар в корзину и отправить в заявке."""
    return mode in ORDERABLE_MODES


def max_quantity(product, mode: str | None = None) -> int:
    """Максимальное количество одной позиции.

    У ``limited`` потолок — реальный остаток на складе (но не выше общего
    предела). У остальных режимов остаток НЕ ограничивает: «под заказ» и
    предзаказ существуют именно для случая, когда на складе пусто.
    """
    mode = mode or resolve_availability(product)
    if not is_orderable(mode):
        return 0
    if mode == "limited":
        stock = int(getattr(product, "stock", 0) or 0)
        return max(1, min(stock, MAX_ITEM_QUANTITY)) if stock > 0 else 1
    return MAX_ITEM_QUANTITY


def clamp_quantity(product, quantity: int, mode: str | None = None) -> int:
    """Привести количество к допустимому диапазону [1, max_quantity]."""
    try:
        q = int(quantity)
    except (TypeError, ValueError):
        q = 1
    limit = max_quantity(product, mode)
    if limit <= 0:
        return 0
    return max(1, min(q, limit))


def availability_payload(product) -> dict:
    """Блок доступности для API (карточка корзины, деталка, снапшот заявки)."""
    mode = resolve_availability(product)
    return {
        "availability_mode": mode,
        "availability_label": AVAILABILITY_LABEL.get(mode, mode),
        "availability_note": AVAILABILITY_NOTE.get(mode, ""),
        "orderable": is_orderable(mode),
        "max_quantity": max_quantity(product, mode),
    }
