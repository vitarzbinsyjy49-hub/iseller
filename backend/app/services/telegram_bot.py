"""Обработчики команд Telegram-бота (v5.5.0).

Модуль намеренно разделён на две части:

- `build_reply(update)` — ЧИСТАЯ функция: принимает разобранный апдейт Telegram
  и возвращает готовый ответ (текст + клавиатура) либо None, если отвечать не
  нужно. Ни одного сетевого вызова, поэтому всё поведение бота — тексты,
  маршруты кнопок, разбор команд — проверяется обычными тестами без Telegram.
- `send_reply()` — тонкая отправка через Bot API.

Кнопки бывают двух видов и обе НЕ требуют обработки на нашей стороне:
`web_app` открывает Mini App, `url` ведёт наружу (менеджер, канал). Поэтому
callback_query бот не получает и обработчика для них нет — это осознанный
выбор, а не пропуск: любая кнопка, требующая callback, добавила бы состояние
и вторую точку отказа.
"""
from __future__ import annotations

import string
from dataclasses import dataclass, field
from html import escape
from urllib.parse import quote

import httpx

from app.core.config import settings

TELEGRAM_API = "https://api.telegram.org"


def telegram_http_kwargs() -> dict:
    """Аргументы httpx для обращений к Telegram: прокси, если он настроен.

    Единая точка на весь проект, чтобы ответы бота и публикация постов в канал
    не разъехались: если Telegram доступен только через прокси, это верно для
    ВСЕХ исходящих обращений к нему, а не для какого-то одного места.
    """
    proxy = (settings.TELEGRAM_PROXY_URL or "").strip()
    return {"proxy": proxy} if proxy else {}


#: Первый экран после «Запустить» — в том числе для платного трафика, за
#: который заплачено поштучно. Порядок абзацев здесь — решение, а не вёрстка:
#: сначала то, ради чего человек кликнул (ассортимент, наличие, как забрать),
#: и только потом дисклеймер. Раньше он стоял вторым и работал ушатом холодной
#: воды ровно на том месте, где человек решает, оставаться ли.
#:
#: Дисклеймер не убран и убран быть не может: он снимает риск квалификации как
#: «дистанционной торговли» — сделка идёт очно, а не через бота.
#:
#: Превосходной степени («самые низкие цены», «лучший выбор») здесь нет
#: намеренно: по ст. 5 ФЗ «О рекламе» такое утверждение требует доказательств,
#: и модерация Яндекс.Директа на него реагирует. Все факты ниже взяты из самого
#: проекта, а не придуманы под объявление: гарантия 1 месяц — warranty_months=1
#: у всех товаров каталога, Горбушка и проверка при вас — из info_posts.py и
#: экрана «Профиль» Mini App. Текст объявлений обязан совпадать с этим по
#: смыслу, иначе объявления не пройдут модерацию.
WELCOME = (
    "AI Seller — техника Apple, Dyson и PlayStation 👋\n"
    "\n"
    "В каталоге только то, что есть в наличии: цена, фото и характеристики "
    "по каждой позиции.\n"
    "\n"
    "Забрать можно на Горбушке в Москве или заказать доставку по России. "
    "Проверяем технику при вас, оплата после проверки, гарантия 1 месяц.\n"
    "\n"
    "ℹ️ Информационный ИИ-каталог, а не интернет-магазин: бот помогает "
    "подобрать технику и оформить заявку, сделка проходит очно при получении."
)

#: Ответ на обычный текст и на опечатку в команде. Клавиатура под ним — та же
#: main_keyboard, поэтому и называем разделы её же словами: «магазин» в тексте
#: против «каталога» на кнопке заставлял человека искать несуществующий пункт.
FALLBACK_TEXT = "Откройте каталог или подберите технику с AI."

# Список для setMyCommands: в меню Telegram команда идёт без ведущего слэша.
BOT_COMMANDS: list[tuple[str, str]] = [
    ("start", "Главное меню"),
    ("catalog", "Каталог"),
    ("ai", "AI-подбор"),
    ("orders", "Мои заявки"),
    ("manager", "Менеджер"),
    ("prices", "Прайс-листы"),
]

MENU_BUTTON_TEXT = "Открыть магазин"


@dataclass
class Reply:
    text: str
    # inline_keyboard как есть, в формате Bot API: список рядов кнопок.
    keyboard: list[list[dict]] = field(default_factory=list)

    def markup(self) -> dict | None:
        return {"inline_keyboard": self.keyboard} if self.keyboard else None


def _mini_app(path: str) -> str | None:
    """Абсолютный https-URL экрана Mini App.

    web_app-кнопки Telegram принимает только по https и только абсолютные.
    Если MINI_APP_URL не настроен, кнопку показывать нельзя — иначе Telegram
    отклонит ВСЁ сообщение целиком, и пользователь не получит вообще ничего
    вместо одной недостающей кнопки.
    """
    base = (settings.MINI_APP_URL or "").strip().rstrip("/")
    if not base.startswith("https://"):
        return None
    return f"{base}{path}"


def _web_app_button(text: str, path: str) -> dict | None:
    url = _mini_app(path)
    return {"text": text, "web_app": {"url": url}} if url else None


def _url_button(text: str, url: str | None) -> dict | None:
    u = (url or "").strip()
    return {"text": text, "url": u} if u.startswith("https://") else None


def _row(*buttons: dict | None) -> list[dict]:
    """Ряд без «дырок»: кнопки с ненастроенным URL просто исчезают."""
    return [b for b in buttons if b]


def _keyboard(*rows: list[dict]) -> list[list[dict]]:
    return [r for r in rows if r]


def main_keyboard() -> list[list[dict]]:
    """Основная клавиатура главного меню."""
    return _keyboard(
        _row(_web_app_button("🛍 Открыть каталог", "/catalog")),
        _row(
            _web_app_button("✨ Подобрать с AI", "/ai"),
            _web_app_button("📦 Мои заявки", "/requests"),
        ),
        _row(_url_button("💬 Связаться с менеджером", settings.MANAGER_RETAIL_URL)),
        _row(_url_button("📢 Наш канал", settings.TELEGRAM_CHANNEL_URL)),
    )


def parse_start_payload(text: str | None) -> str | None:
    """Аргумент deep link: «/start price_iphone» -> «price_iphone».

    Кнопки в канале не могут быть web_app (Telegram отвергает такое сообщение
    целиком), поэтому они ведут на t.me/<bot>?start=<раздел>. Пользователь
    попадает в чат с ботом, и вот здесь мы обязаны открыть именно тот раздел,
    ради которого он нажал кнопку, — иначе кнопка «Открыть раздел» превратится
    в обычное «Открыть магазин».
    """
    if not text:
        return None
    parts = text.strip().split(maxsplit=1)
    if len(parts) < 2 or not parts[0].startswith("/start"):
        return None
    payload = parts[1].strip()
    return payload if payload else None


def parse_command(text: str | None) -> str | None:
    """Имя команды без слэша и без @упоминания бота, или None.

    Telegram дописывает `@botusername` к командам в группах, а некоторые клиенты
    делают это и в личке — `/start@isellerAIbot` обязан работать так же, как
    `/start`. Аргументы после пробела (deep link `/start ref=...`) отбрасываем.
    """
    if not text:
        return None
    head = text.strip().split(maxsplit=1)[0] if text.strip() else ""
    if not head.startswith("/"):
        return None
    name = head[1:].split("@", 1)[0]
    return name.lower() or None


def parse_product_payload(payload: str) -> int | None:
    """«product_42» -> 42. Всё остальное -> None.

    Строгая проверка на цифры обязательна: payload приходит из ссылки, которую
    мог собрать кто угодно, а результат подставляется в URL кнопки. `isdigit`
    здесь мало — он пропускает юникод-цифры вроде «٤٢», поэтому проверяем по
    ASCII и заодно отсекаем неправдоподобно длинные значения.
    """
    prefix = "product_"
    if not payload.startswith(prefix):
        return None
    raw = payload[len(prefix):]
    if not raw or len(raw) > 12 or not all(c in "0123456789" for c in raw):
        return None
    value = int(raw)
    return value if value > 0 else None


#: Кнопка-запрос: `q_mac-mini` -> каталог, отфильтрованный по «mac mini».
#:
#: Нужна там, где заводить раздел прайса ради одной модели избыточно. Mac mini,
#: iMac, Mac Studio и мониторы лежат внутри широких категорий «компьютеры» и
#: «мониторы»; человеку нужен не новый раздел канала, а сразу суженная выдача.
#: Раздел пришлось бы заводить в коде, публиковать отдельным постом и потом
#: поддерживать — кнопка-запрос даёт то же самое одной ссылкой.
_QUERY_PREFIX = "q_"
#: Свой предел длины, а не «сколько пропустит Telegram»: payload приходит из
#: ссылки, которую мог собрать кто угодно.
_QUERY_PAYLOAD_MAX = 48
_QUERY_ALLOWED = set(string.ascii_lowercase + string.digits + "-")


def parse_query_payload(payload: str) -> str | None:
    """«q_mac-mini» -> «mac mini». Всё остальное -> None.

    Проверка строгая по той же причине, что и у `parse_product_payload`:
    значение подставляется в URL кнопки. Разрешены только строчная латиница,
    цифры и дефис — дефис работает разделителем слов. Кириллица не нужна:
    запрос уходит в поиск по названиям товаров, а они латиницей.
    """
    if not payload.startswith(_QUERY_PREFIX):
        return None
    raw = payload[len(_QUERY_PREFIX):]
    if not raw or len(raw) > _QUERY_PAYLOAD_MAX:
        return None
    if not set(raw) <= _QUERY_ALLOWED:
        return None
    # Несколько дефисов подряд и по краям не должны давать пустых слов:
    # «q_mac--mini-» и «q_mac-mini» обязаны вести в одно и то же место.
    query = " ".join(word for word in raw.split("-") if word)
    return query or None


#: Префикс рекламных payload'ов: ad_<кампания>. Работает по обеим ссылкам:
#: t.me/<bot>/<app>?startapp=ad_<кампания> (прямой вход в Mini App — Telegram
#: кладёт метку в initDataUnsafe.start_param, фронт отдаёт её в /auth/telegram)
#: и t.me/<bot>?start=ad_<кампания> (вход в ЧАТ с ботом). Во втором случае
#: Telegram start_param в Mini App НЕ прокидывает — источник пишется другим
#: путём, через первое касание (см. services/ad_touch.py). Платный трафик ведём
#: именно в чат: только он даёт боту право писать человеку дальше.
AD_PAYLOAD_PREFIX = "ad_"

#: Символы, допустимые в метке канала — ровно то, что Telegram пропускает в
#: startapp-параметре (A-Z a-z 0-9 _ -).
AD_SLUG_ALPHABET = frozenset(string.ascii_letters + string.digits + "_-")

#: Потолок метки. Считается вместе с остальным: «ad_» (3) + метка (40) +
#: «_product_» (9) + id товара (12, кап parse_product_payload) = ровно 64 —
#: лимит Telegram на start-параметр. Двигать любое из этих чисел вверх нельзя,
#: не пересчитав остальные (держит test_ad_product_payload_fits_telegram_limit).
AD_SLUG_MAX = 40

#: Хвост рекламного payload'а с товаром: «ad_direct_product_42».
#: Формат согласован с обычным «product_42» из parse_product_payload и обратно
#: совместим: до этого патча такая строка проходила как метка целиком и вела в
#: каталог, поэтому старые ссылки не ломаются ни в какой момент выкатки.
AD_PRODUCT_SEPARATOR = "_product_"


def _valid_ad_slug(slug: str) -> str | None:
    """Метка кампании, если она проходит allowlist, иначе None.

    Allowlist перечислен явно, а не через `isalnum()`: тот пропускает юникод
    («ad_москва», «ad_٤٢»), а Telegram в startapp отдаёт только эти символы —
    всё остальное к нам приходит мимо реальной ссылки и источником не является.
    """
    if not slug or len(slug) > AD_SLUG_MAX or not all(c in AD_SLUG_ALPHABET for c in slug):
        return None
    return slug


def split_ad_payload(payload: str) -> tuple[str | None, int | None]:
    """«ad_direct_product_42» -> («direct», 42); «ad_direct» -> («direct», None).

    Метка и товар разбираются ВМЕСТЕ и ровно в одном месте: разъедься они —
    объявление вело бы на один экран, а источник писался бы от другой кампании.

    Метка НЕ включает хвост товара намеренно. Иначе каждое объявление стало бы
    отдельным источником, и точный `==` фильтр админки перестал бы агрегировать
    кампанию целиком.

    Разбор с конца (rpartition) и с откатом: если хвост после «_product_» не
    похож на id товара, вся строка снова считается меткой — ровно то поведение,
    которое было до этого патча. Поэтому «ad_product_42» — это по-прежнему
    кампания «product_42» и каталог, а не товар без кампании.
    """
    if not payload.startswith(AD_PAYLOAD_PREFIX):
        return None, None
    body = payload[len(AD_PAYLOAD_PREFIX):]
    head, separator, tail = body.rpartition(AD_PRODUCT_SEPARATOR)
    if separator:
        slug = _valid_ad_slug(head)
        # Валидация id — та же и тем же кодом, что у обычного диплинка на товар:
        # только ASCII-цифры, ограничение длины, > 0.
        product_id = parse_product_payload(f"product_{tail}")
        if slug is not None and product_id is not None:
            return slug, product_id
    return _valid_ad_slug(body), None


def parse_ad_payload(payload: str) -> str | None:
    """«ad_moskvatoday» -> «moskvatoday» — метка рекламной кампании, иначе None.

    Тип возврата фиксирован: функцию зовут из api/auth.py и из services/ad_touch.py,
    и «метка» — это всё, что им нужно. Товар из того же payload'а достаёт
    parse_ad_product_id.
    """
    return split_ad_payload(payload)[0]


def parse_ad_product_id(payload: str) -> int | None:
    """«ad_direct_product_42» -> 42. Рекламный payload без товара -> None."""
    return split_ad_payload(payload)[1]


#: Реферальный payload: ref_<код>. Работает тем же конвейером атрибуции, что
#: рекламный (см. AD_PAYLOAD_PREFIX), но ведём мы ТОЛЬКО в чат: вход по
#: ?startapp= не даёт боту права писать человеку, и приглашённый навсегда
#: остался бы без напоминаний о корзине и статусов заявки.
REF_PAYLOAD_PREFIX = "ref_"

#: Длина кода. Фиксирована, а не «до N»: строка чужого формата нужной длины
#: кодом не является, и проверка длины отсекает мусор до похода в базу.
REF_CODE_LENGTH = 8


def parse_ref_payload(payload: str) -> str | None:
    """«ref_A1b2C3d4» -> «A1b2C3d4»; всё остальное -> None.

    Allowlist перечислен явно, а не через isalnum(): последний пропускает
    юникод («ref_абвгдежз»), а Telegram в start-параметре отдаёт только эти
    символы — всё прочее приходит к нам мимо реальной ссылки.
    """
    if not payload or not payload.startswith(REF_PAYLOAD_PREFIX):
        return None
    code = payload[len(REF_PAYLOAD_PREFIX):]
    if len(code) != REF_CODE_LENGTH or not all(c in AD_SLUG_ALPHABET for c in code):
        return None
    return code


#: Статические payload'ы диплинков -> экран Mini App. Словарь, а не цепочка
#: if'ов: по нему проходит тест, который требует от бота web_app-кнопки на тот
#: же путь для КАЖДОГО payload'а. Новый диплинк, добавленный только сюда и
#: забытый в reply_for_payload, роняет тест, а не тихо ведёт в общее меню.
STATIC_ROUTES: dict[str, str] = {
    "catalog": "/catalog",
    "ai": "/ai",
    "requests": "/requests",
    "sell": "/sell",
    "marketplace": "/marketplace",
    # Роудмап живёт шторкой в профиле, своего маршрута у него нет — открываем
    # профиль и просим его развернуть шторку меткой в адресе.
    "roadmap": "/profile?roadmap=1",
}


def resolve_payload_path(payload: str) -> str | None:
    """Путь Mini App для deep-link payload'а, или None если payload незнаком.

    Источник правды один на два потребителя: `reply_for_payload` ниже строит
    web_app-кнопку в ответе бота (путь ?start= домотал до сюда), а фронт зовёт
    тот же payload через /api/deeplink/{payload} при запуске по ?startapp= —
    прямом переходе в Mini App, минуя чат с ботом вовсе. Разъедутся эти два
    пути — человек с прямой ссылки попадёт не туда, куда с ссылки через бота.
    """
    route = STATIC_ROUTES.get(payload)
    if route is not None:
        return route
    product_id = parse_product_payload(payload)
    if product_id is not None:
        return f"/product/{product_id}"
    query = parse_query_payload(payload)
    if query is not None:
        return f"/catalog?query={quote(query)}"
    # Рекламный payload. С товаром — сразу карточка: человек кликнул объявление
    # «PS5 Slim за 42 900» и обязан увидеть именно её, а не витрину, на которой
    # эту PS5 ещё надо найти. Без товара метка сама по себе не экран — открываем
    # каталог, как по обычной ссылке "catalog". Атрибуция идёт отдельно (см.
    # AD_PAYLOAD_PREFIX), здесь чисто про навигацию.
    ad_slug, ad_product_id = split_ad_payload(payload)
    if ad_slug is not None:
        if ad_product_id is not None:
            return f"/product/{ad_product_id}"
        return STATIC_ROUTES["catalog"]
    from app.services.price_posts import SECTIONS_BY_SLUG   # локально: избегаем цикла

    section = SECTIONS_BY_SLUG.get(payload)
    return section.route if section is not None else None


def reply_for_payload(payload: str) -> Reply | None:
    """Ответ на deep link: раздел прайса, каталог, AI-подбор или товар.

    Здесь web_app-кнопки уже законны — это личный чат с ботом, а не канал.
    """
    from app.services.price_posts import SECTIONS_BY_SLUG   # локально: избегаем цикла

    # Рекламный переход через чат (?start=). Ответ обязан совпадать с тем, куда
    # ведёт resolve_payload_path тот же payload по ?startapp=, иначе человек с
    # двух ссылок на одно объявление попадёт на разные экраны.
    ad_slug, ad_product_id = split_ad_payload(payload)
    if ad_slug is not None and ad_product_id is not None:
        # Переиспользуем ветку обычного диплинка на товар, а не дублируем её:
        # два похожих ответа разъезжаются на первой же правке текста.
        return reply_for_payload(f"product_{ad_product_id}")
    if payload == "catalog" or ad_slug is not None:
        return build_reply({"message": {"chat": {"type": "private"}, "text": "/catalog"}})
    if payload == "ai":
        return build_reply({"message": {"chat": {"type": "private"}, "text": "/ai"}})
    # Кнопка "Мои заявки" (kind=requests) в конструкторе инфо-постов админки
    # собирает именно такой payload — без этой ветки он не резолвился и молча
    # падал в общее меню вместо фокусированного экрана заявок.
    if payload == "requests":
        return build_reply({"message": {"chat": {"type": "private"}, "text": "/orders"}})

    if payload == "sell":
        button = _web_app_button("📦 Предложить товар", "/sell")
        if button is None:
            return Reply(WELCOME, main_keyboard())
        return Reply(
            "Расскажите о своей технике — в несколько шагов.",
            _keyboard(_row(button)),
        )
    if payload == "marketplace":
        button = _web_app_button("🛍 Смотреть маркетплейс", "/marketplace")
        if button is None:
            return Reply(WELCOME, main_keyboard())
        return Reply(
            "Витрина техники, которую разместили другие пользователи.",
            _keyboard(_row(button)),
        )
    if payload == "roadmap":
        button = _web_app_button("🗺 Что будет дальше", "/profile?roadmap=1")
        if button is None:
            return Reply(WELCOME, main_keyboard())
        return Reply(
            "Планы магазина на сентябрь и дальше — прямо в приложении.",
            _keyboard(_row(button)),
        )

    # Товар, которым поделились. НАЗВАНИЕ ТОВАРА ЗДЕСЬ НЕ ЧИТАЕТСЯ ИЗ БАЗЫ
    # намеренно: build_reply и reply_for_payload не ходят в БД и не ходят в
    # сеть, поэтому всё поведение бота проверяется обычными тестами. Название
    # человек и так видит в сообщении, по которому пришёл; наша задача —
    # довести его до карточки одним нажатием.
    product_id = parse_product_payload(payload)
    if product_id is not None:
        button = _web_app_button("🛍 Открыть товар", f"/product/{product_id}")
        if button is None:
            # Mini App не настроен — кнопки не будет; отправлять сообщение с
            # обещанием и без кнопки хуже, чем общее меню.
            return Reply(WELCOME, main_keyboard())
        return Reply(
            "Вот товар, которым с вами поделились.",
            _keyboard(
                _row(button),
                _row(
                    _web_app_button("🛍 Весь каталог", "/catalog"),
                    _url_button("💬 Менеджер", settings.MANAGER_RETAIL_URL),
                ),
            ),
        )

    # Кнопка-запрос из канала. Ответ обязан вести туда же, куда resolve_payload_path
    # ведёт тот же payload по ?startapp=, иначе человек с двух ссылок на одну
    # кнопку попадёт на разные экраны.
    query = parse_query_payload(payload)
    if query is not None:
        button = _web_app_button(f"🛍 Показать «{query}»", f"/catalog?query={quote(query)}")
        if button is None:
            return Reply(WELCOME, main_keyboard())
        return Reply(
            # escape: текст уходит с parse_mode=HTML, а запрос пришёл из ссылки.
            # Символы разметки в нём Telegram отклонил бы вместе со всем ответом.
            f"Вот что нашлось по запросу «{escape(query)}».",
            _keyboard(
                _row(button),
                _row(
                    _web_app_button("✨ Подобрать с AI", "/ai"),
                    _url_button("💬 Менеджер", settings.MANAGER_RETAIL_URL),
                ),
            ),
        )

    section = SECTIONS_BY_SLUG.get(payload)
    if section is None:
        return None
    button = _web_app_button(f"🛍 Открыть раздел «{section.title}»", section.route)
    return Reply(
        # escape: текст уходит с parse_mode=HTML, и «&» в названии раздела
        # заставил бы Telegram отклонить сообщение целиком. Названия сейчас —
        # константы кода, но это единственное, что их защищает.
        f"{section.emoji} <b>{escape(section.title)}</b>\n"
        "\nОткройте раздел в каталоге — там актуальные цены, фото и наличие.",
        _keyboard(
            _row(button),
            _row(
                _web_app_button("✨ Подобрать с AI", "/ai"),
                _url_button("💬 Менеджер", settings.MANAGER_RETAIL_URL),
            ),
        ),
    )


#: Медиа, у которого нам бывает нужен file_id, и подпись типа для ответа.
_FILE_ID_KINDS: tuple[tuple[str, str], ...] = (
    ("video", "видео"),
    ("animation", "гиф"),
    ("document", "файл"),
    ("audio", "аудио"),
    ("photo", "фото"),
)


def _file_id_reply(message: dict) -> Reply | None:
    """Ответ с file_id на присланное админом медиа, иначе None.

    Зачем. Bot API поднимает файлы до 50 МБ — ролик на 1,7 ГБ бот загрузить не
    может НИКАК. Зато отправка уже загруженного файла ПО file_id размером не
    ограничена. Значит путь один: человек заливает файл руками (клиент Telegram
    берёт до 2 ГБ), пересылает боту, а бот дальше публикует его в канал с
    подписью и кнопками — то, чего вручную не сделать, потому что инлайн-кнопки
    ставит только бот.

    Отвечаем ТОЛЬКО админу: file_id — это ключ к файлу для нашего бота, и
    раздавать его кому попало незачем. Всем остальным медиа как молчали, так и
    молчат — прежнее поведение не меняется.
    """
    from app.services.notifications import admin_chat_id

    admin = admin_chat_id()
    if admin is None:
        return None
    sender = message.get("from") or {}
    if not isinstance(sender, dict) or sender.get("id") != admin:
        return None

    for key, label in _FILE_ID_KINDS:
        payload = message.get(key)
        if not payload:
            continue
        # У фото Telegram присылает список размеров — берём последний, он же
        # самый крупный; у остального объект один.
        item = payload[-1] if isinstance(payload, list) else payload
        if not isinstance(item, dict):
            continue
        file_id = item.get("file_id")
        if not file_id:
            continue
        return Reply(f"file_id этого {label}:\n\n<code>{file_id}</code>")
    return None


def build_reply(update: dict) -> Reply | None:
    """Ответ на апдейт Telegram, или None если реагировать не нужно.

    Отвечаем только на текстовые сообщения в личном чате. Всё остальное
    (правки сообщений, вступления в чат, посты канала — в том числе наши
    собственные посты в канале магазина) осознанно игнорируем: бот не должен
    комментировать свои же публикации.
    """
    message = update.get("message") or {}
    if not isinstance(message, dict):
        return None
    chat = message.get("chat") or {}
    if chat.get("type") != "private":
        return None

    file_reply = _file_id_reply(message)
    if file_reply is not None:
        return file_reply

    text = message.get("text")
    if not isinstance(text, str) or not text.strip():
        return None

    command = parse_command(text)

    # Переход по кнопке из канала: открываем ровно тот раздел, который нажали.
    payload = parse_start_payload(text)
    if command == "start" and payload:
        reply = reply_for_payload(payload)
        if reply is not None:
            return reply

    if command in (None, "start", "menu"):
        if command is None:
            # Обычный текст: подсказка + та же основная клавиатура.
            return Reply(FALLBACK_TEXT, main_keyboard())
        return Reply(WELCOME, main_keyboard())

    if command == "catalog":
        return Reply(
            "Каталог AI Seller — актуальные цены и наличие.",
            _keyboard(_row(_web_app_button("🛍 Открыть каталог", "/catalog"))),
        )
    if command == "ai":
        return Reply(
            "AI-подбор поможет выбрать устройство под ваши задачи и бюджет.",
            _keyboard(_row(_web_app_button("✨ Подобрать с AI", "/ai"))),
        )
    if command == "orders":
        return Reply(
            "Ваши заявки и их статусы.",
            _keyboard(_row(_web_app_button("📦 Мои заявки", "/requests"))),
        )
    if command == "manager":
        return Reply(
            "Менеджер ответит на вопросы по товарам, наличию и доставке.",
            _keyboard(_row(_url_button("💬 Связаться с менеджером", settings.MANAGER_RETAIL_URL))),
        )
    if command == "prices":
        return Reply(
            "Актуальные прайс-листы публикуем в нашем канале — там же обновления "
            "цен и поступления.",
            _keyboard(
                _row(_url_button("📢 Наш канал", settings.TELEGRAM_CHANNEL_URL)),
                _row(_web_app_button("🛍 Открыть каталог", "/catalog")),
            ),
        )

    # Неизвестная команда — тот же ответ, что и на обычный текст: пользователь
    # не должен упереться в молчание, опечатавшись в команде.
    return Reply(FALLBACK_TEXT, main_keyboard())


#: message_id последнего ответа бота в чате, для звонков БЕЗ db (тесты,
#: разовые скрипты) — тогда трекинг живёт в памяти процесса и не переживает
#: рестарт. Продовые вызовы (bot_polling.py, api/telegram.py) всегда передают
#: db — см. _load_last_bot_message/_save_last_bot_message ниже: бот
#: перезапускается на каждый деплой, и внутрипроцессный словарь после
#: рестарта пуст — именно так чат начинал копить дубли ровно с этого момента.
_last_bot_message: dict[int | str, int] = {}


def _delete_message(chat_id: int | str, message_id: int) -> None:
    """Удалить сообщение в чате. Best-effort: оно могло быть уже удалено
    вручную или устареть для Telegram — это не повод ронять обработку
    текущего апдейта, поэтому ошибки publisher'а здесь глотаются."""
    from app.services.telegram_publisher import TelegramPublishError, call

    try:
        call("deleteMessage", {"chat_id": chat_id, "message_id": message_id})
    except TelegramPublishError:
        pass


def _load_last_bot_message(db, chat_id: int | str) -> int | None:
    """Прочитать сохранённый id из users.last_bot_message_id.

    chat_id приватного чата с ботом всегда равен telegram_id (build_reply
    отвечает только на private-сообщения). Строки может не быть — человек
    написал боту, ни разу не открыв приложение (Mini App создаёт User при
    логине); тогда трекинг молча не работает, апдейт всё равно обрабатывается.
    """
    from app.models.user import User

    try:
        user = db.query(User).filter(User.telegram_id == int(chat_id)).first()
    except (TypeError, ValueError):
        return None
    return user.last_bot_message_id if user else None


def _save_last_bot_message(db, chat_id: int | str, message_id: int | None) -> None:
    from app.models.user import User

    try:
        user = db.query(User).filter(User.telegram_id == int(chat_id)).first()
    except (TypeError, ValueError):
        return
    if user is None:
        return
    user.last_bot_message_id = message_id
    db.commit()


def send_reply(
    chat_id: int | str, reply: Reply, *, incoming_message_id: int | None = None, db=None,
) -> None:
    """Отправить ответ. Ошибки Telegram логируются вызывающим кодом.

    `parse_mode=HTML` обязателен: тексты ответов содержат разметку (`<b>` в
    ответе на кнопку раздела из канала). Без него Telegram показывает теги
    БУКВАЛЬНО — человек, пришедший по кнопке из канала, видел «📱 <b>iPhone</b>»
    вместе с угловыми скобками. Это был самый заметный путь входа в магазин.

    Раз режим HTML включён, любая подстановка в текст обязана экранироваться
    (см. `escape` в reply_for_payload): неэкранированный «&» в тексте заставит
    Telegram отклонить сообщение ЦЕЛИКОМ, и человек не получит ничего.

    Чат держится чистым: перед отправкой удаляется предыдущий ответ бота в
    этом чате — иначе команды пользователя копят в чате одинаковые сообщения.
    `db` — сессия для персистентного трекинга (users.last_bot_message_id);
    без неё используется словарь в памяти процесса (см. `_last_bot_message`),
    это годится только для тестов/разовых вызовов — продовые вызовы обязаны
    передавать db, иначе трекинг не переживёт следующий деплой.
    `incoming_message_id` — id сообщения самого пользователя (`/start`,
    `/catalog`...), которое вызвало этот ответ; оно удаляется тоже, вызывающий
    код передаёт его из апдейта Telegram.
    Уведомления (`services/notifications.py` — падение цены, неоплаченная
    корзина) и посты канала идут другими функциями, этот путь их не касается —
    их история остаётся навсегда.
    """
    if not settings.TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not configured")

    if db is not None:
        previous_message_id = _load_last_bot_message(db, chat_id)
    else:
        previous_message_id = _last_bot_message.pop(chat_id, None)
    if previous_message_id is not None:
        _delete_message(chat_id, previous_message_id)
    if incoming_message_id is not None:
        _delete_message(chat_id, incoming_message_id)

    payload: dict = {
        "chat_id": chat_id,
        "text": reply.text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    markup = reply.markup()
    if markup:
        payload["reply_markup"] = markup

    # Отправляем через общий retry-слой publisher'а (429 + сетевые сбои), а не
    # одиночным httpx.post. Причина конкретная: исходящие в Telegram идут через
    # WARP-прокси, и обрыв там — обычное дело, а не исключительная ситуация. При
    # единственной попытке такой обрыв означал, что человек написал боту и НЕ
    # ПОЛУЧИЛ НИЧЕГО, причём молча: ретраить некому, входящий апдейт уже
    # подтверждён сдвинутым offset'ом.
    #
    # Импорт локальный: publisher сам импортирует этот модуль (telegram_http_kwargs),
    # и на уровне модуля вышел бы цикл. Тот же приём, что в reply_for_payload.
    from app.services.telegram_publisher import call

    result = call("sendMessage", payload)

    if isinstance(result, dict):
        message_id = result.get("message_id")
        if message_id is not None:
            if db is not None:
                _save_last_bot_message(db, chat_id, int(message_id))
            else:
                _last_bot_message[chat_id] = int(message_id)
