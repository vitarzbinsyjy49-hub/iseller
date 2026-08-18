"""Тексты уведомлений — чистые функции, без сети и без БД (патч 1.1).

Тот же приём, что у `telegram_bot.build_reply` и `price_posts`: всё, что можно
проверить без Telegram, проверяется без Telegram. Здесь нет ни одного вызова
Bot API — только «данные -> (текст, клавиатура)».

Денежные и складские утверждения берутся ИСКЛЮЧИТЕЛЬНО из переданных данных.
Придумывать сроки («будет готово завтра»), скидки и обещания доставки здесь
нельзя: магазин не сможет их выполнить, а сообщение уйдёт от его имени.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from html import escape

from app.services.telegram_bot import _row, _url_button, _web_app_button, _keyboard
from app.core.config import settings

#: Всё, что приходит из каталога (названия товаров), проходит через escape.
#: Уведомления уходят с parse_mode=HTML, и одно «&» в названии — например
#: «Dyson Airwrap & аксессуары» — заставит Telegram отклонить сообщение
#: ЦЕЛИКОМ. Человек не получит ничего, а строка в очереди потратит все попытки
#: на ошибку, которая повтором не лечится. Названия приходят из XLSX-импорта,
#: то есть их содержимое магазин не контролирует.
_esc = escape


@dataclass
class Message:
    """Готовое уведомление: текст + клавиатура в формате Bot API."""

    text: str
    keyboard: list[list[dict]] = field(default_factory=list)


def format_money(value: float | None, currency: str = "RUB") -> str:
    """«94 000 ₽». Тот же вид, что на витрине (frontend/lib/format.ts)."""
    if value is None:
        return ""
    amount = f"{round(float(value)):,}".replace(",", " ")
    suffix = "₽" if currency in (None, "", "RUB") else currency
    return f"{amount} {suffix}"


def plural_items(count: int) -> str:
    """«1 товар / 2 товара / 5 товаров»."""
    tail = count % 100
    if 11 <= tail <= 14:
        return f"{count} товаров"
    match count % 10:
        case 1:
            return f"{count} товар"
        case 2 | 3 | 4:
            return f"{count} товара"
        case _:
            return f"{count} товаров"


# ============================ Статус заявки ============================
#
# Уведомляем НЕ на каждый статус. Осознанно пропущены:
#   new         — заявку только что создал сам человек, он видел экран успеха;
#                 сообщать ему «ваша заявка создана» — шум через две секунды;
#   in_progress — с точки зрения покупателя неотличим от contacted; два
#                 сообщения про одно и то же читаются как сбой системы.
#
# Статуса, которого здесь нет, не существует и для уведомлений — молча.
_STATUS_TEXTS: dict[str, tuple[str, str]] = {
    "contacted": (
        "Менеджер взял заявку в работу",
        "Скоро свяжемся с вами, чтобы подтвердить наличие и детали получения.",
    ),
    "confirming": (
        "Уточняем детали заявки",
        "Проверяем наличие и подбираем удобный способ получения.",
    ),
    "confirmed": (
        "Заявка подтверждена",
        "Состав и цена согласованы. Менеджер напишет по срокам получения.",
    ),
    "reserved": (
        "Товар отложен для вас",
        "Придержим позиции до вашего визита. Если планы изменились — напишите менеджеру.",
    ),
    "completed": (
        "Заявка выполнена",
        "Спасибо за покупку! Будем рады видеть вас снова.",
    ),
    "cancelled": (
        "Заявка отменена",
        "Если это ошибка или вы хотите вернуться к покупке — напишите менеджеру, поможем.",
    ),
}

#: Заявка «нашли дешевле» живёт по другой логике: человек не покупку оформлял,
#: а прислал ссылку и ждёт ответа по ЦЕНЕ. Общие формулировки («состав и цена
#: согласованы», «товар отложен») в этом разговоре звучат мимо. Оверлей
#: переопределяет ТОЛЬКО те статусы, где текст отличается; на остальных
#: работает общий словарь — второй полный список статусов разъехался бы с
#: первым на ближайшей правке.
_PRICE_OFFER_STATUS_TEXTS: dict[str, tuple[str, str]] = {
    "contacted": (
        "Проверяем вашу ссылку",
        "Менеджер сверяет цену на площадке и скоро напишет.",
    ),
    "confirming": (
        "Сверяем цену",
        "Уточняем условия у поставщика — ответим, как только будет ясность.",
    ),
    "confirmed": (
        "Готовы дать эту цену",
        "Менеджер напишет вам, чтобы договориться о получении.",
    ),
    "cancelled": (
        "По этой ссылке цену повторить не сможем",
        "Так бывает: у площадки другая поставка или условия. Напишите менеджеру — подберём вариант.",
    ),
}

#: Статусы, о которых пишем пользователю. Один источник и для шаблонов, и для
#: producer'а: список в двух местах разъехался бы на первой же правке.
NOTIFIABLE_STATUSES: tuple[str, ...] = tuple(_STATUS_TEXTS)


def lead_status_message(
    *, status: str, public_number: str, items_count: int = 0,
    estimated_total: float | None = None, currency: str = "RUB",
    product_title: str | None = None, lead_type: str | None = None,
) -> Message | None:
    """Уведомление о смене статуса заявки, либо None если статус «немой».

    Состав заявки описываем ровно так, как он есть: заявка-корзина — числом
    позиций и предварительной суммой, одиночная — названием товара. Сумму
    называем предварительной, потому что она и есть предварительная: цена
    подтверждается менеджером (то же правило, что на панели корзины).

    `lead_type` меняет только формулировки (см. `_PRICE_OFFER_STATUS_TEXTS`), но
    не набор уведомляемых статусов: молчим мы везде одинаково.
    """
    entry = _STATUS_TEXTS.get(status)
    # Оверлей именно ПЕРЕОПРЕДЕЛЯЕТ, а не расширяет: статус, о котором мы молчим
    # всем, обязан молчать и здесь. Иначе «немой» in_progress заговорил бы у
    # одного типа заявок, и правило «молчим одинаково» перестало бы быть правдой.
    if entry is not None and lead_type == "price_offer":
        entry = _PRICE_OFFER_STATUS_TEXTS.get(status, entry)
    if entry is None:
        return None
    headline, explanation = entry

    lines = [f"<b>{headline}</b>", "", f"Заявка {public_number}"]
    if items_count and items_count > 0:
        line = plural_items(items_count)
        if estimated_total is not None:
            line += f" · {format_money(estimated_total, currency)}"
        lines.append(line)
    elif product_title:
        lines.append(_esc(product_title))
    lines += ["", explanation]

    return Message(
        "\n".join(lines),
        _keyboard(
            _row(_web_app_button("📦 Мои заявки", "/requests")),
            _row(_url_button("💬 Менеджер", settings.MANAGER_RETAIL_URL)),
        ),
    )


# ===================== «Нашли дешевле» — владельцу =====================
def price_offer_message(
    *, product_title: str, our_price: float | None, competitor_price: float | None,
    competitor_url: str, competitor_shop: str, username: str | None,
) -> Message:
    """Заявка «нашли дешевле» владельцу.

    Ссылку НЕ оборачиваем в <a> и не экранируем как текст ссылки: владельцу
    нужен виден сам адрес, чтобы оценить площадку ДО перехода. Цена конкурента
    приходит со слов покупателя — так и подписана, потому что проверить её мы
    не можем и делать вид, что можем, нельзя.
    """
    who = f"@{username}" if username else "покупатель"
    lines = [
        "💸 <b>Нашли дешевле</b>",
        "",
        f"<b>{_esc(product_title)}</b>",
        f"Наша цена: {format_money(our_price) or '—'}",
    ]
    if competitor_price is not None:
        lines.append(f"У них: {format_money(competitor_price)} (со слов покупателя)")
        if our_price is not None and our_price > competitor_price:
            lines.append(f"Разница: {format_money(our_price - competitor_price)}")
    else:
        lines.append("У них: цена не указана")
    lines += [
        f"Площадка: {_esc(competitor_shop)}",
        "",
        _esc(competitor_url),
        "",
        f"От: {_esc(who)}",
    ]
    return Message("\n".join(lines))


# ================ «Предложить товар» — модератору ================
def sell_item_message(*, title: str, price_wanted, phone: str | None, username: str | None) -> Message:
    """Новая заявка «Предложить товар» — алерт модератору в «Заявки»."""
    who = f"@{username}" if username else "покупатель"
    lines = [
        "🏷️ <b>Новая заявка: предложили товар</b>",
        "",
        f"<b>{_esc(title)}</b>",
        f"Желаемая цена: {format_money(price_wanted) or '—'}",
        f"От: {who}" + (f", {_esc(phone)}" if phone else ""),
        "",
        "Смотрите фото и детали в «Заявках» админки.",
    ]
    return Message(text="\n".join(lines))


#: Заголовок получает тег сценария — Trade-In/опт/бизнес читаются иначе, чем
#: обычный заказ, и менеджеру полезно видеть это раньше, чем состав заявки.
_LEAD_TYPE_TAG: dict[str, str] = {
    "trade_in": "Trade-In",
    "b2b": "Для бизнеса",
    "wholesale": "Опт",
    "cart": "Корзина",
}

#: Длиннее — не влезет в превью уведомления, и суть комментария всё равно
#: видна по первым символам; полный текст менеджер откроет в самой заявке.
_MESSAGE_PREVIEW_LIMIT = 200


def _lead_composition(*, items_count: int, estimated_total, currency: str, product_title) -> str | None:
    """Строка состава — общая для нового шаблона и для lead_status_message:
    количество позиций + предварительная сумма для заявки-корзины, либо
    название товара для одиночной. None — состав неизвестен (заявка без
    товара и без позиций, например Trade-In без выбранной модели)."""
    if items_count and items_count > 0:
        line = plural_items(items_count)
        if estimated_total is not None:
            line += f" · {format_money(estimated_total, currency)}"
        return line
    if product_title:
        return _esc(product_title)
    return None


# ==================== Новая заявка — менеджеру ====================
def new_lead_message(
    *, public_number: str, items_count: int = 0, estimated_total: float | None = None,
    currency: str = "RUB", product_title: str | None = None, lead_type: str | None = None,
    username: str | None = None, phone: str | None = None, message: str | None = None,
) -> Message:
    """Алерт менеджеру о новой заявке — для типов, у которых нет своего более
    специфичного уведомления (price_offer/sell_item оповещают отдельно, до
    этой ветки в вызывающем коде)."""
    tag = _LEAD_TYPE_TAG.get(lead_type or "")
    headline = f"🆕 <b>Новая заявка{': ' + tag if tag else ''}</b>"
    lines = [headline, "", f"Заявка {public_number}"]

    composition = _lead_composition(
        items_count=items_count, estimated_total=estimated_total,
        currency=currency, product_title=product_title,
    )
    if composition:
        lines.append(composition)

    who = f"@{username}" if username else "покупатель"
    contact = who + (f", {_esc(phone)}" if phone else "")
    lines += ["", f"От: {contact}"]

    if message:
        trimmed = message if len(message) <= _MESSAGE_PREVIEW_LIMIT else message[:_MESSAGE_PREVIEW_LIMIT] + "…"
        lines += ["", _esc(trimmed)]

    lines += ["", "Смотрите в «Заявках» админки."]
    return Message("\n".join(lines))


# ================ Отмена заявки покупателем — менеджеру ================
def lead_cancelled_by_user_message(
    *, public_number: str, items_count: int = 0, estimated_total: float | None = None,
    currency: str = "RUB", product_title: str | None = None, username: str | None = None,
) -> Message:
    """Симметрично lead_status_message(status='cancelled'), которое уходит
    ПОКУПАТЕЛЮ при отмене менеджером: здесь наоборот — покупатель отменил сам,
    уведомляем менеджера."""
    lines = ["❌ <b>Покупатель отменил заявку</b>", "", f"Заявка {public_number}"]

    composition = _lead_composition(
        items_count=items_count, estimated_total=estimated_total,
        currency=currency, product_title=product_title,
    )
    if composition:
        lines.append(composition)

    who = f"@{username}" if username else "покупатель"
    lines += ["", f"От: {who}"]
    return Message("\n".join(lines))


# ========================= Брошенная корзина =========================
def cart_reminder_message(
    *, items_count: int, estimated_total: float | None, currency: str = "RUB",
    titles: list[str] | None = None,
) -> Message | None:
    """Напоминание о собранной, но не отправленной корзине.

    Никаких выдуманных стимулов: ни скидки за возврат, ни «осталось 2 штуки»,
    ни таймера. Сумма — предварительная и посчитана по актуальным ценам
    каталога (см. cart_payload), поэтому её можно называть вслух.

    Пустая корзина уведомления не порождает: None здесь означает «сообщать не о
    чем», и это не ошибка.
    """
    if items_count <= 0:
        return None

    lines = ["<b>Ваша корзина ждёт</b>", ""]
    head = plural_items(items_count)
    if estimated_total is not None:
        head += f" · {format_money(estimated_total, currency)}"
    lines.append(head)

    # Первые названия — чтобы человек узнал СВОЮ корзину, а не гадал, о чём речь.
    for title in (titles or [])[:3]:
        lines.append(f"• {_esc(title)}")
    if titles and len(titles) > 3:
        lines.append(f"…и ещё {plural_items(len(titles) - 3)}")

    lines += [
        "",
        "Отправьте заявку — менеджер подтвердит наличие и цену, "
        "оплата и бронь при этом не требуются.",
    ]

    return Message(
        "\n".join(lines),
        _keyboard(
            _row(_web_app_button("🛒 Открыть корзину", "/cart")),
            _row(_url_button("💬 Менеджер", settings.MANAGER_RETAIL_URL)),
        ),
    )


# ========================= Избранное =========================
def favorite_message(
    *, product_id: int, title: str, price: float, currency: str = "RUB",
    previous_price: float | None = None, back_in_stock: bool = False,
) -> Message | None:
    """Новость про товар из избранного: подешевел и/или снова в наличии.

    ОДНО сообщение на товар, даже когда произошло и то, и другое. Два сообщения
    подряд про один и тот же телефон читаются как сбой рассылки, а не как забота:
    возвращение в наличие и так показывает актуальную цену.

    Заголовок выбирается по важности: «снова в наличии» — это про возможность
    купить вообще, снижение цены — про условия. Если товара не было, главная
    новость именно первая.

    None означает «новости нет» — это нормальный исход, а не ошибка.
    """
    if not back_in_stock and previous_price is None:
        return None

    if back_in_stock:
        headline = "Снова в наличии"
        # Про снижение упоминаем строкой ниже, отдельным сообщением — нет.
        tail = "Товар из вашего избранного снова можно заказать."
    else:
        headline = "Цена снизилась"
        tail = "Товар из вашего избранного."

    lines = [f"<b>{headline}</b>", "", _esc(title)]

    price_line = format_money(price, currency)
    if previous_price is not None:
        # «Было» — это цена, которую МЫ называли в прошлый раз, а не вчерашняя:
        # человек сравнивает с тем, что знает от нас.
        price_line += f" (было {format_money(previous_price, currency)})"
    lines += [price_line, "", tail]

    return Message(
        "\n".join(lines),
        _keyboard(
            _row(_web_app_button("Открыть товар", f"/product/{product_id}")),
            _row(_web_app_button("⭐️ Избранное", "/favorites")),
        ),
    )
