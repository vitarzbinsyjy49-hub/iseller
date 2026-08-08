"""Проверка ссылки на товар у конкурента для сценария «нашли дешевле».

Страницу НЕ загружаем и цену НЕ парсим — осознанное решение. Крупные площадки
закрыты антиботом (DNS отдаёт нам 401, Ozon и Я.Маркет — редиректы на защиту),
и парсер, который сегодня работает, завтра тихо начнёт возвращать пустоту.
Молча неверная цена хуже отсутствующей, поэтому проверяем только форму ссылки,
а решение принимает человек.
"""
from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from app.schemas.ai import META_MAX_URL_LEN

#: Предел длины ссылки. Совпадает с пределом строки-адреса в metadata заявки:
#: если он окажется больше, `sanitize_lead_metadata` обрежет ссылку молча.
MAX_URL_LENGTH = META_MAX_URL_LEN

#: Грубый предел на сырой ввод — до разбора. Защищает от мегабайтной строки:
#: до очистки хвостов мы ещё не знаем итоговой длины, но парсить такое незачем.
_RAW_LIMIT = MAX_URL_LENGTH * 4

#: Хосты, на которые ссылаться бессмысленно: это мы сами.
_OWN_HOSTS = {"158.255.1.248.sslip.io", "admin.158.255.1.248.sslip.io", "t.me"}

#: Параметры аналитики — режем, чтобы ссылка читалась глазами.
_TRACKING_PREFIXES = ("utm_", "yclid", "gclid", "fbclid", "_openstat", "from")

#: Понятные имена площадок. Не влияет на логику, только на текст владельцу.
_KNOWN_SHOPS = {
    "ozon.ru": "Ozon",
    "mvideo.ru": "М.Видео",
    "dns-shop.ru": "DNS",
    "citilink.ru": "Ситилинк",
    "eldorado.ru": "Эльдорадо",
    "wildberries.ru": "Wildberries",
    "market.yandex.ru": "Яндекс Маркет",
    "avito.ru": "Авито",
    "restore.ru": "re:Store",
}


class OfferLinkError(ValueError):
    """Ссылку нельзя принять — текст исключения показывается пользователю."""


def normalize_offer_url(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        raise OfferLinkError("Пришлите ссылку на товар")
    if len(text) > _RAW_LIMIT:
        raise OfferLinkError("Ссылка слишком длинная")

    # Из строки браузера схема часто теряется при копировании.
    if "://" not in text:
        text = "https://" + text

    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https"):
        raise OfferLinkError("Ссылка должна начинаться с http:// или https://")

    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        raise OfferLinkError("Не похоже на адрес магазина")

    bare = host[4:] if host.startswith("www.") else host
    if _is_own_host(host) or _is_own_host(bare):
        raise OfferLinkError("Это ссылка на наш же магазин")

    kept = [
        (k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if not any(k.lower().startswith(p) for p in _TRACKING_PREFIXES)
    ]
    cleaned = urlunparse(parsed._replace(query=urlencode(kept), fragment=""))

    # Длину считаем ПОСЛЕ очистки: аналитический хвост длиной в километр — не
    # повод отказать человеку, ведь в базу он всё равно не попадёт.
    if len(cleaned) > MAX_URL_LENGTH:
        raise OfferLinkError("Ссылка слишком длинная")
    return cleaned


def _is_own_host(host: str) -> bool:
    """Наш хост — сам домен или что угодно под ним."""
    return any(host == own or host.endswith("." + own) for own in _OWN_HOSTS)


def shop_name(url: str) -> str:
    """Человеческое имя площадки; для незнакомых — сам хост."""
    host = (urlparse(url).hostname or "").lower()
    bare = host[4:] if host.startswith("www.") else host
    for known, label in _KNOWN_SHOPS.items():
        if bare == known or bare.endswith("." + known):
            return label
    return bare
