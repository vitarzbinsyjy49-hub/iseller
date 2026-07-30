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

from app.services.telegram_bot import _row, _url_button, _web_app_button, _keyboard
from app.core.config import settings


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

#: Статусы, о которых пишем пользователю. Один источник и для шаблонов, и для
#: producer'а: список в двух местах разъехался бы на первой же правке.
NOTIFIABLE_STATUSES: tuple[str, ...] = tuple(_STATUS_TEXTS)


def lead_status_message(
    *, status: str, public_number: str, items_count: int = 0,
    estimated_total: float | None = None, currency: str = "RUB",
    product_title: str | None = None,
) -> Message | None:
    """Уведомление о смене статуса заявки, либо None если статус «немой».

    Состав заявки описываем ровно так, как он есть: заявка-корзина — числом
    позиций и предварительной суммой, одиночная — названием товара. Сумму
    называем предварительной, потому что она и есть предварительная: цена
    подтверждается менеджером (то же правило, что на панели корзины).
    """
    entry = _STATUS_TEXTS.get(status)
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
        lines.append(product_title)
    lines += ["", explanation]

    return Message(
        "\n".join(lines),
        _keyboard(
            _row(_web_app_button("📦 Мои заявки", "/requests")),
            _row(_url_button("💬 Менеджер", settings.MANAGER_RETAIL_URL)),
        ),
    )


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
        lines.append(f"• {title}")
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
