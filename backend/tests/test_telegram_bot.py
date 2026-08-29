"""Тесты Telegram-бота (v5.5.0): разбор команд, ответы, вебхук.

Контракт:
- POST /api/telegram/webhook  — приём апдейтов, защищён secret_token в заголовке
  X-Telegram-Bot-Api-Secret-Token; ВСЕГДА отвечает 200 при верном секрете.

Ключевое свойство, которое проверяется отдельно: вебхук не отдаёт 5xx на
внутренней ошибке. Telegram повторяет доставку, пока не увидит успех, поэтому
5xx означал бы дубли ответов пользователю, а не «починимся позже».
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.services import telegram_bot
from app.services.telegram_bot import BOT_COMMANDS, Reply, build_reply, parse_command

SECRET = "test-webhook-secret"


@pytest.fixture(autouse=True)
def bot_settings(monkeypatch):
    """Настроенный бот: https Mini App, менеджер и канал заданы."""
    monkeypatch.setattr(settings, "MINI_APP_URL", "https://shop.example.com", raising=False)
    monkeypatch.setattr(settings, "MANAGER_RETAIL_URL", "https://t.me/manager", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_URL", "https://t.me/aisellerhub", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_BOT_TOKEN", "test-token", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_WEBHOOK_SECRET", SECRET, raising=False)


@pytest.fixture(autouse=True)
def clear_bot_message_tracking():
    """`_last_bot_message` — состояние процесса, общее для всех тестов.

    Без сброса тест, использующий chat_id 555 (стандартный в этом файле),
    может неожиданно унаследовать message_id от предыдущего теста и получить
    лишний вызов deleteMessage."""
    telegram_bot._last_bot_message.clear()
    yield
    telegram_bot._last_bot_message.clear()


def private_message(text: str, chat_id: int = 555) -> dict:
    return {
        "update_id": 1,
        "message": {
            "message_id": 10,
            "chat": {"id": chat_id, "type": "private"},
            "text": text,
        },
    }


def all_buttons(reply: Reply) -> list[dict]:
    return [b for row in reply.keyboard for b in row]


# ---------------------------------------------------------------- разбор команд

@pytest.mark.parametrize(
    "text,expected",
    [
        ("/start", "start"),
        ("/START", "start"),
        ("/start@isellerAIbot", "start"),   # клиент дописывает @username
        ("/start ref=promo", "start"),      # deep link: аргумент отбрасываем
        ("  /catalog  ", "catalog"),
        ("привет", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_command(text, expected):
    assert parse_command(text) == expected


# ---------------------------------------------------------------- /start

def test_start_text_matches_spec():
    reply = build_reply(private_message("/start"))
    assert reply.text.startswith("Добро пожаловать в AI Seller 👋")
    assert "Техника Apple, Dyson и PlayStation по актуальным ценам." in reply.text
    assert "AI-подбором" in reply.text


def test_welcome_includes_legal_disclaimer():
    """Снимает риск квалификации как «дистанционной торговли»: сделка (оплата,
    передача товара) идёт очно, а не через бота/приложение."""
    assert "не интернет-магазин" in telegram_bot.WELCOME
    assert "очно" in telegram_bot.WELCOME


def test_start_keyboard_layout_and_routes():
    reply = build_reply(private_message("/start"))
    rows = reply.keyboard
    assert [len(r) for r in rows] == [1, 2, 1, 1]
    assert rows[0][0]["text"] == "🛍 Открыть каталог"
    assert rows[0][0]["web_app"]["url"] == "https://shop.example.com/catalog"
    assert rows[1][0]["web_app"]["url"] == "https://shop.example.com/ai"
    assert rows[1][1]["web_app"]["url"] == "https://shop.example.com/requests"
    assert rows[2][0]["url"] == "https://t.me/manager"
    assert rows[3][0]["url"] == "https://t.me/aisellerhub"


# ---------------------------------------------------------------- прочие команды

@pytest.mark.parametrize(
    "command,expected_url",
    [
        ("/catalog", "https://shop.example.com/catalog"),
        ("/ai", "https://shop.example.com/ai"),
        ("/orders", "https://shop.example.com/requests"),
    ],
)
def test_webapp_commands_route_to_expected_screen(command, expected_url):
    reply = build_reply(private_message(command))
    urls = [b["web_app"]["url"] for b in all_buttons(reply) if "web_app" in b]
    assert urls == [expected_url]


def test_manager_command_links_to_manager():
    reply = build_reply(private_message("/manager"))
    assert [b["url"] for b in all_buttons(reply)] == ["https://t.me/manager"]


def test_prices_command_leads_to_channel():
    reply = build_reply(private_message("/prices"))
    assert "канале" in reply.text
    assert "https://t.me/aisellerhub" in [b.get("url") for b in all_buttons(reply)]


def test_every_declared_command_gets_an_answer():
    """Ни одна команда из setMyCommands не должна оставлять пользователя в тишине."""
    for name, _title in BOT_COMMANDS:
        reply = build_reply(private_message(f"/{name}"))
        assert reply is not None and reply.text.strip(), name


# ---------------------------------------------------------------- обычный текст

def test_plain_text_gets_hint_and_main_keyboard():
    reply = build_reply(private_message("хочу айфон"))
    assert reply.text == "Откройте магазин или воспользуйтесь AI-подбором."
    assert reply.keyboard == build_reply(private_message("/start")).keyboard


def test_unknown_command_answers_instead_of_silence():
    reply = build_reply(private_message("/catalogue"))   # опечатка
    assert reply.text == "Откройте магазин или воспользуйтесь AI-подбором."


# ---------------------------------------------------------------- что игнорируем

def test_channel_post_is_ignored():
    """Бот публикует посты в свой канал и не должен отвечать на собственные посты."""
    assert build_reply({"channel_post": {"chat": {"id": -100, "type": "channel"}, "text": "/start"}}) is None


def test_group_message_is_ignored():
    update = private_message("/start")
    update["message"]["chat"]["type"] = "group"
    assert build_reply(update) is None


def test_non_text_message_is_ignored():
    update = private_message("/start")
    del update["message"]["text"]
    assert build_reply(update) is None


# ------------------------------------------------- деградация при пустом конфиге

def test_missing_urls_drop_buttons_but_keep_the_answer(monkeypatch):
    """Ненастроенный URL убирает кнопку, а не всё сообщение.

    Telegram отклоняет сообщение целиком, если у кнопки пустой url — тогда
    пользователь не получил бы вообще ничего вместо одной кнопки.
    """
    monkeypatch.setattr(settings, "MINI_APP_URL", "", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_URL", "", raising=False)
    reply = build_reply(private_message("/start"))
    assert reply.text.startswith("Добро пожаловать")
    assert [b["url"] for b in all_buttons(reply)] == ["https://t.me/manager"]


def test_http_mini_app_url_is_rejected(monkeypatch):
    """web_app-кнопки Telegram принимает только по https."""
    monkeypatch.setattr(settings, "MINI_APP_URL", "http://insecure.example.com", raising=False)
    reply = build_reply(private_message("/catalog"))
    assert all_buttons(reply) == []


# ---------------------------------------------------------------- вебхук

@pytest.fixture()
def client():
    return TestClient(app)


def test_webhook_rejects_wrong_secret(client):
    r = client.post("/api/telegram/webhook", json=private_message("/start"),
                    headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"})
    assert r.status_code == 403


def test_webhook_rejects_missing_secret(client):
    r = client.post("/api/telegram/webhook", json=private_message("/start"))
    assert r.status_code == 403


def test_webhook_is_disabled_when_secret_not_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_WEBHOOK_SECRET", "", raising=False)
    r = client.post("/api/telegram/webhook", json=private_message("/start"),
                    headers={"X-Telegram-Bot-Api-Secret-Token": ""})
    assert r.status_code == 404


def test_webhook_sends_reply(client, monkeypatch):
    sent: list[tuple] = []

    def fake_send(chat_id, reply, incoming_message_id=None, db=None):
        sent.append((chat_id, reply, incoming_message_id))

    monkeypatch.setattr(telegram_bot, "send_reply", fake_send)
    monkeypatch.setattr("app.api.telegram.send_reply", fake_send)
    r = client.post("/api/telegram/webhook", json=private_message("/start", chat_id=777),
                    headers={"X-Telegram-Bot-Api-Secret-Token": SECRET})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert len(sent) == 1
    chat_id, reply, incoming_message_id = sent[0]
    assert chat_id == 777
    assert reply.text.startswith("Добро пожаловать")
    assert incoming_message_id == 10  # message_id из private_message()


def test_webhook_answers_200_even_if_sending_fails(client, monkeypatch):
    """Иначе Telegram будет ретраить и пользователь получит дубли ответов."""
    def boom(chat_id, reply, incoming_message_id=None, db=None):
        raise RuntimeError("Telegram недоступен")
    monkeypatch.setattr("app.api.telegram.send_reply", boom)
    r = client.post("/api/telegram/webhook", json=private_message("/start"),
                    headers={"X-Telegram-Bot-Api-Secret-Token": SECRET})
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_webhook_survives_broken_body(client):
    r = client.post("/api/telegram/webhook", content=b"not json",
                    headers={"X-Telegram-Bot-Api-Secret-Token": SECRET,
                             "Content-Type": "application/json"})
    assert r.status_code == 200


def test_webhook_does_not_leak_internals(client, monkeypatch):
    def boom(chat_id, reply, incoming_message_id=None, db=None):
        raise RuntimeError("секрет в тексте ошибки")
    monkeypatch.setattr("app.api.telegram.send_reply", boom)
    r = client.post("/api/telegram/webhook", json=private_message("/start"),
                    headers={"X-Telegram-Bot-Api-Secret-Token": SECRET})
    assert r.json() == {"ok": True}
    assert "секрет" not in r.text


# ---------------------------------------------------------------- setup-скрипт

def test_setup_script_never_prints_the_webhook_secret():
    """Вывод скрипта попадает в логи деплоя и в переписку — секрета там быть не должно."""
    from app.scripts.setup_bot import _redact

    payload = {"url": "https://shop.example.com/api/telegram/webhook",
               "secret_token": "s3cr3t-value", "allowed_updates": ["message"]}
    printed = _redact(payload)
    assert printed["secret_token"] == "<скрыто>"
    assert "s3cr3t-value" not in str(printed)
    assert printed["url"] == payload["url"]        # несекретные поля видны как есть


# ---------------------------------------------------------------- прокси

def test_no_proxy_by_default(monkeypatch):
    from app.services.telegram_bot import telegram_http_kwargs

    monkeypatch.setattr(settings, "TELEGRAM_PROXY_URL", "", raising=False)
    assert telegram_http_kwargs() == {}


def test_proxy_is_used_when_configured(monkeypatch):
    """Сеть некоторых хостингов не пропускает Telegram: входящий вебхук доходит,
    а исходящие ответы бота — нет. Тогда обращения идут через прокси."""
    from app.services.telegram_bot import telegram_http_kwargs

    monkeypatch.setattr(settings, "TELEGRAM_PROXY_URL", " socks5://127.0.0.1:40000 ", raising=False)
    assert telegram_http_kwargs() == {"proxy": "socks5://127.0.0.1:40000"}


def test_channel_publishing_uses_the_same_proxy(monkeypatch):
    """Публикация постов в канал ходит в тот же api.telegram.org — если он
    доступен только через прокси, это верно и для неё."""
    import app.services.telegram_publisher as publisher

    monkeypatch.setattr(settings, "TELEGRAM_PROXY_URL", "socks5://127.0.0.1:40000", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "@channel", raising=False)
    seen: dict = {}

    class FakeResponse:
        is_success = True
        def json(self):
            return {"ok": True, "result": {"message_id": 1}}

    def fake_post(url, **kwargs):
        seen.update(kwargs)
        return FakeResponse()

    monkeypatch.setattr(publisher.httpx, "post", fake_post)
    publisher.publish_post(title="t", body="b", image_url=None)
    assert seen.get("proxy") == "socks5://127.0.0.1:40000"


def test_publish_post_rejects_oversized_photo_caption(monkeypatch):
    """Подпись к фото ограничена 1024 символами Telegram. Раньше текст молча
    резался (text[:1024]) — админ получал «успех» и обрезанный пост в канале."""
    import app.services.telegram_publisher as publisher

    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "@channel", raising=False)

    def fail_post(*a, **kw):
        raise AssertionError("не должно дойти до сети — лимит проверяется раньше")

    monkeypatch.setattr(publisher.httpx, "post", fail_post)
    with pytest.raises(publisher.TelegramContentTooLong):
        publisher.publish_post(title="T", body="x" * 1100, image_url="https://example.com/a.jpg")


def test_publish_post_rejects_oversized_text_message(monkeypatch):
    """Обычное сообщение (без фото) ограничено 4096 символами."""
    import app.services.telegram_publisher as publisher

    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "@channel", raising=False)

    def fail_post(*a, **kw):
        raise AssertionError("не должно дойти до сети — лимит проверяется раньше")

    monkeypatch.setattr(publisher.httpx, "post", fail_post)
    with pytest.raises(publisher.TelegramContentTooLong):
        publisher.publish_post(title="T", body="x" * 4200, image_url=None)


def test_publish_post_uploads_own_image_as_multipart(monkeypatch, tmp_path):
    """Своя загрузка (не внешний URL) должна уйти файлом в теле запроса, а не
    ссылкой — Telegram не умеет сам скачивать медиа с нашего боевого домена."""
    import app.services.telegram_publisher as publisher
    from app.core import uploads

    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "@channel", raising=False)
    monkeypatch.setattr(uploads, "UPLOAD_DIR", tmp_path)
    (tmp_path / "pic.png").write_bytes(b"bytes")

    seen: dict = {}

    class FakeResponse:
        is_success = True
        def json(self):
            return {"ok": True, "result": {"message_id": 1}}

    def fake_post(url, **kwargs):
        seen.update(kwargs)
        return FakeResponse()

    monkeypatch.setattr(publisher.httpx, "post", fake_post)
    publisher.publish_post(title="T", body="b", image_url="/api/uploads/pic.png")

    assert "files" in seen and "photo" in seen["files"]
    assert seen["files"]["photo"][1] == b"bytes"
    assert "json" not in seen or seen.get("json") is None


# ------------------------------------------------- deep link из канала

def test_start_payload_is_parsed():
    from app.services.telegram_bot import parse_start_payload

    assert parse_start_payload("/start price_iphone") == "price_iphone"
    assert parse_start_payload("/start@isellerAIbot ai") == "ai"
    assert parse_start_payload("/start") is None
    assert parse_start_payload("привет") is None


def test_deep_link_from_channel_opens_that_section():
    """Кнопка «Открыть раздел» в канале обязана открыть ИМЕННО этот раздел.

    В канале web_app-кнопки запрещены, поэтому переход идёт через
    t.me/<bot>?start=<slug>. Если payload проигнорировать, кнопка раздела
    превратится в обычное «открыть магазин», и связь с постом потеряется.
    """
    reply = build_reply(private_message("/start price_iphone"))
    assert "iPhone" in reply.text
    urls = [b["web_app"]["url"] for row in reply.keyboard for b in row if "web_app" in b]
    assert any("category=%D1%81%D0%BC" in u or "смартфоны" in u for u in urls)


@pytest.mark.parametrize("payload,expected", [
    ("catalog", "/catalog"),
    ("ai", "/ai"),
])
def test_generic_payloads_open_expected_screens(payload, expected):
    reply = build_reply(private_message(f"/start {payload}"))
    urls = [b["web_app"]["url"] for row in reply.keyboard for b in row if "web_app" in b]
    assert any(u.endswith(expected) for u in urls)


def test_requests_payload_opens_the_orders_screen_focused():
    """Админка предлагает кнопку "Мои заявки" (kind=requests, BUTTON_KINDS в
    info_posts.py), но до этого фикса payload "requests" не резолвился в
    reply_for_payload и молча падал в ОБЩЕЕ меню. Общее меню тоже содержит
    кнопку с URL, оканчивающимся на /requests (среди прочих) — поэтому
    достаточно широкая проверка "есть такая кнопка" её бы не поймала:
    нужен именно фокусированный ответ /orders, а не всё меню сразу."""
    reply = build_reply(private_message("/start requests"))
    assert reply.text == "Ваши заявки и их статусы."
    assert len(reply.keyboard) == 1 and len(reply.keyboard[0]) == 1
    assert reply.keyboard[0][0]["web_app"]["url"].endswith("/requests")


def test_unknown_payload_falls_back_to_the_main_menu():
    """Устаревшая ссылка из старого поста не должна упираться в тишину."""
    reply = build_reply(private_message("/start price_deleted_section"))
    assert reply.text.startswith("Добро пожаловать")


def test_sell_payload_opens_the_wizard_focused():
    reply = build_reply(private_message("/start sell"))
    assert len(reply.keyboard) == 1 and len(reply.keyboard[0]) == 1
    assert reply.keyboard[0][0]["web_app"]["url"].endswith("/sell")


def test_marketplace_payload_opens_the_marketplace_focused():
    reply = build_reply(private_message("/start marketplace"))
    assert len(reply.keyboard) == 1 and len(reply.keyboard[0]) == 1
    assert reply.keyboard[0][0]["web_app"]["url"].endswith("/marketplace")


def test_roadmap_payload_opens_the_profile_with_the_sheet_unfolded():
    """Кнопка поста про планы обязана привести к самой шторке, а не к профилю:
    метка ?roadmap=1 — единственное, чем профиль отличает этот переход."""
    reply = build_reply(private_message("/start roadmap"))
    assert len(reply.keyboard) == 1 and len(reply.keyboard[0]) == 1
    assert reply.keyboard[0][0]["web_app"]["url"].endswith("/profile?roadmap=1")


# ------------------------------------------------- resolve_payload_path (startapp)

def test_resolve_payload_path_matches_what_the_bot_itself_opens():
    """Общий с ботом источник правды: путь, который резолвит эта функция для
    фронта (startapp/start_param), обязан совпадать с тем web_app-путём,
    который бот подставляет в кнопку своего ответа на тот же payload —
    иначе прямой переход в Mini App и переход через чат бота разъедутся."""
    from app.services.price_posts import SECTIONS_BY_SLUG
    from app.services.telegram_bot import resolve_payload_path

    assert resolve_payload_path("catalog") == "/catalog"
    assert resolve_payload_path("ai") == "/ai"
    assert resolve_payload_path("requests") == "/requests"
    assert resolve_payload_path("sell") == "/sell"
    assert resolve_payload_path("marketplace") == "/marketplace"
    assert resolve_payload_path("roadmap") == "/profile?roadmap=1"
    assert resolve_payload_path("product_42") == "/product/42"
    assert resolve_payload_path("price_iphone") == SECTIONS_BY_SLUG["price_iphone"].route
    assert resolve_payload_path("совсем не существует") is None
    assert resolve_payload_path("product_abc") is None


# ------------------------------------------------- deep link на товар (патч 1.1)

@pytest.mark.parametrize("payload,expected", [
    ("product_42", 42),
    ("product_1", 1),
    ("product_999999", 999999),
])
def test_parse_product_payload_accepts_real_ids(payload, expected):
    assert telegram_bot.parse_product_payload(payload) == expected


@pytest.mark.parametrize("payload", [
    "product_",           # без id
    "product_abc",        # не число
    "product_-1",         # отрицательный
    "product_0",          # нулевой id товара не существует
    "product_1.5",        # дробный
    "product_1/../admin", # попытка вылезти из маршрута
    "product_٤٢",         # арабские цифры: isdigit() их принимает, int() тоже
    "product_" + "9" * 20,  # неправдоподобно длинный
    "catalog",
    "",
])
def test_parse_product_payload_rejects_junk(payload):
    """Payload приходит из ссылки, которую мог собрать кто угодно, а результат
    подставляется в URL кнопки — поэтому проверка строгая, по ASCII-цифрам."""
    assert telegram_bot.parse_product_payload(payload) is None


def test_shared_product_link_opens_the_card():
    reply = build_reply(private_message("/start product_42"))
    urls = [b["web_app"]["url"] for row in reply.keyboard for b in row if "web_app" in b]
    assert "https://shop.example.com/product/42" in urls


def test_shared_product_link_without_mini_app_falls_back_to_menu(monkeypatch):
    """Без настроенного Mini App кнопки не будет.

    Обещать «вот товар» и не дать кнопку хуже, чем показать обычное меню:
    человек пришёл по ссылке друга и обязан куда-то попасть.
    """
    monkeypatch.setattr(settings, "MINI_APP_URL", "", raising=False)
    reply = build_reply(private_message("/start product_42"))
    assert reply.text.startswith("Добро пожаловать")


# ------------------------------------------------- разметка ответов (ревизия)

def test_send_reply_uses_html_parse_mode(monkeypatch):
    """Без parse_mode Telegram показывает теги БУКВАЛЬНО.

    Ответ на кнопку раздела из канала содержит <b>, и пользователь видел
    «📱 <b>iPhone</b>» вместе с угловыми скобками — на самом заметном пути
    входа в магазин (канал -> бот -> Mini App).
    """
    sent = {}
    monkeypatch.setattr("app.services.telegram_publisher.call",
                        lambda method, payload: sent.update(payload) or {"message_id": 1})
    telegram_bot.send_reply(555, Reply("<b>Привет</b>"))
    assert sent["parse_mode"] == "HTML"
    assert sent["chat_id"] == 555


def test_send_reply_retries_through_the_publisher(monkeypatch):
    """Одна попытка = молчание бота при обрыве связи.

    Исходящие идут через WARP-прокси, где обрыв — обычное дело. Апдейт при
    этом уже подтверждён сдвинутым offset'ом, повторить его некому: человек
    написал боту и не получил НИЧЕГО. Поэтому отправка идёт через общий
    retry-слой publisher'а.
    """
    from app.services.telegram_publisher import MAX_ATTEMPTS, TelegramPublishError

    monkeypatch.setattr("app.services.telegram_publisher._sleep", lambda s: None)

    calls = []

    def counting_post(*a, **kw):
        calls.append(1)
        raise httpx.ConnectError("нет сети")

    monkeypatch.setattr("app.services.telegram_publisher.httpx.post", counting_post)
    with pytest.raises(TelegramPublishError):
        telegram_bot.send_reply(555, Reply("привет"))
    assert len(calls) == MAX_ATTEMPTS, "отправка обязана повторяться, а не сдаваться сразу"


# --------------------------------------- чистый чат: одно сообщение бота, входящая команда удаляется

def test_send_reply_deletes_previous_bot_message_before_sending_a_new_one(monkeypatch):
    """Второй ответ бота в тот же чат удаляет первый — правило действует для
    любой команды (/catalog, /ai, главное меню), а не только для кликов по
    кнопкам канала, как было в мини-фиксе."""
    calls = []
    monkeypatch.setattr(
        "app.services.telegram_publisher.call",
        lambda method, payload: calls.append((method, payload)) or {"message_id": len(calls) + 100},
    )

    telegram_bot.send_reply(555, Reply("раздел 1"))
    telegram_bot.send_reply(555, Reply("раздел 2"))

    assert [c[0] for c in calls] == ["sendMessage", "deleteMessage", "sendMessage"]
    assert calls[1][1] == {"chat_id": 555, "message_id": 101}


def test_send_reply_deletes_the_incoming_command_message(monkeypatch):
    """/start, /catalog и т.п., отправленные самим пользователем, не должны
    оставаться в чате — удаляются вместе с отправкой ответа."""
    calls = []
    monkeypatch.setattr(
        "app.services.telegram_publisher.call",
        lambda method, payload: calls.append((method, payload)) or {"message_id": 1},
    )

    telegram_bot.send_reply(555, Reply("ответ"), incoming_message_id=42)

    assert ("deleteMessage", {"chat_id": 555, "message_id": 42}) in calls


def test_send_reply_without_incoming_message_id_does_not_delete_anything_extra(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.services.telegram_publisher.call",
        lambda method, payload: calls.append((method, payload)) or {"message_id": 1},
    )

    telegram_bot.send_reply(555, Reply("ответ"))

    assert [c[0] for c in calls] == ["sendMessage"]


def test_send_reply_ignores_delete_failures(monkeypatch):
    """Сообщение могло быть уже удалено вручную (своё или чужое) — апдейт
    всё равно должен обработаться, а не упасть на удалении."""
    from app.services.telegram_publisher import TelegramPublishError

    def fake_call(method, payload):
        if method == "deleteMessage":
            raise TelegramPublishError("message to delete not found")
        return {"message_id": 1}

    monkeypatch.setattr("app.services.telegram_publisher.call", fake_call)
    telegram_bot._last_bot_message[555] = 999

    telegram_bot.send_reply(555, Reply("раздел"), incoming_message_id=42)  # не должно бросить


# --------------------------------------- чистый чат переживает рестарт бота

def test_send_reply_with_db_persists_last_message_id_across_restarts(db, monkeypatch):
    """Регрессия с прода: бот перезапускается на каждый деплой, внутрипроцессный
    _last_bot_message после рестарта пуст, и старое сообщение переставало
    удаляться — чат копил дубли "Открыть каталог" один на каждый деплой.

    С db= трекинг живёт в users.last_bot_message_id, а не в памяти процесса —
    поэтому явно чистим _last_bot_message между вызовами, симулируя рестарт:
    поведение обязано остаться прежним (удалить старое, отправить новое)."""
    from app.models.user import User

    user = User(telegram_id=555, first_name="Тест")
    db.add(user)
    db.commit()

    calls = []
    monkeypatch.setattr(
        "app.services.telegram_publisher.call",
        lambda method, payload: calls.append((method, payload)) or {"message_id": len(calls) + 100},
    )

    telegram_bot.send_reply(555, Reply("раздел 1"), db=db)
    telegram_bot._last_bot_message.clear()  # "рестарт бота" — память процесса пуста
    telegram_bot.send_reply(555, Reply("раздел 2"), db=db)

    assert [c[0] for c in calls] == ["sendMessage", "deleteMessage", "sendMessage"]
    assert calls[1][1] == {"chat_id": 555, "message_id": 101}
    db.refresh(user)
    assert user.last_bot_message_id == 103


def test_send_reply_without_a_known_user_skips_persistence_quietly(db, monkeypatch):
    """chat_id без строки в users (написал боту, ни разу не открыв приложение)
    — трекинг молча не работает, апдейт всё равно должен обработаться."""
    calls = []
    monkeypatch.setattr(
        "app.services.telegram_publisher.call",
        lambda method, payload: calls.append((method, payload)) or {"message_id": 1},
    )

    telegram_bot.send_reply(999999, Reply("привет"), db=db)  # не должно бросить

    assert [c[0] for c in calls] == ["sendMessage"]


def test_section_reply_escapes_the_title(monkeypatch):
    """Раз режим HTML включён, подстановки обязаны экранироваться.

    Неэкранированный «&» заставляет Telegram отклонить сообщение ЦЕЛИКОМ —
    человек не получает ничего вместо одного кривого символа.
    """
    from app.services import price_posts

    class FakeSection:
        emoji = "📱"
        title = "Ноутбуки & моноблоки"
        route = "/catalog?category=laptops"

    monkeypatch.setitem(price_posts.SECTIONS_BY_SLUG, "price_test", FakeSection())
    reply = telegram_bot.reply_for_payload("price_test")
    assert "&amp;" in reply.text
    assert "Ноутбуки & моноблоки" not in reply.text


def test_static_reply_texts_are_html_safe():
    """Все постоянные тексты бота обязаны переживать parse_mode=HTML.

    Голый «&» в приветствии сломал бы ответ на /start для всех сразу.
    """
    import re

    texts = [telegram_bot.WELCOME, telegram_bot.FALLBACK_TEXT]
    for command in ("/start", "/catalog", "/ai", "/orders", "/manager", "/prices", "привет"):
        reply = build_reply(private_message(command))
        texts.append(reply.text)

    for text in texts:
        # «&», не открывающий HTML-сущность, — ошибка разметки для Telegram.
        assert not re.search(r"&(?!(amp|lt|gt|quot|#\d+);)", text), text
        # Незакрытых тегов быть не должно: считаем открывающие и закрывающие.
        assert text.count("<") == text.count(">"), text


# ------------------------------------------------- покрытие всех диплинков сразу

def test_every_deep_link_gets_a_button_to_the_same_screen():
    """Каждый payload из STATIC_ROUTES обязан дать ответ бота с web_app-кнопкой
    ровно на тот экран, который резолвит Mini App.

    Тест перечисляет не сами payload'ы, а СЛОВАРЬ: добавить новый диплинк и
    забыть про него в reply_for_payload теперь нельзя — забытый payload молча
    падал бы в общее меню, и кнопка канала вела бы «куда-то в магазин».
    """
    from app.services.telegram_bot import STATIC_ROUTES, reply_for_payload

    for payload, route in STATIC_ROUTES.items():
        reply = reply_for_payload(payload)
        assert reply is not None, f"payload {payload}: бот не ответил"
        urls = [b["web_app"]["url"] for row in reply.keyboard for b in row if "web_app" in b]
        assert urls, f"payload {payload}: ответ без web_app-кнопки"
        assert any(u.endswith(route) for u in urls), (
            f"payload {payload}: бот ведёт на {urls}, а Mini App на {route}"
        )


def test_unknown_and_broken_input_never_leaves_the_user_in_silence():
    """Мусор на входе — не повод промолчать: человек, опечатавшийся в команде
    или приславший что угодно, обязан получить ответ с рабочими кнопками."""
    for text in ["/kataloq", "/start@isellerAIbot", "/start   ", "  /menu  ",
                 "🙂" * 50, "x" * 4000, "/start неизвестный_payload"]:
        reply = build_reply(private_message(text))
        assert reply is not None, f"бот промолчал на {text[:30]!r}"
        assert reply.text.strip(), f"пустой ответ на {text[:30]!r}"
        assert reply.keyboard, f"ответ без кнопок на {text[:30]!r}"


def test_product_payload_rejects_anything_that_is_not_a_plain_number():
    """payload приходит из ссылки, которую мог собрать кто угодно, а результат
    подставляется в URL кнопки."""
    from app.services.telegram_bot import parse_product_payload

    for bad in ["product_", "product_abc", "product_0", "product_-1", "product_٤٢",
                "product_1e3", "product_" + "9" * 13, "product_1 2"]:
        assert parse_product_payload(bad) is None, bad
    assert parse_product_payload("product_42") == 42


def _video_update(sender_id: int, file_id: str = "BAACAgIAAxkBAAI") -> dict:
    return {"message": {
        "chat": {"type": "private"},
        "from": {"id": sender_id},
        "video": {"file_id": file_id, "duration": 1608},
    }}


def test_video_from_admin_returns_file_id(monkeypatch):
    """Ролик на 1,7 ГБ бот загрузить не может (Bot API — 50 МБ), а отправить
    по file_id уже загруженный файл — может, без ограничения размера. Поэтому
    админ пересылает видео боту, а бот отдаёт ключ к нему."""
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    reply = telegram_bot.build_reply(_video_update(999, "FILE_ID_ABC"))
    assert reply is not None
    assert "FILE_ID_ABC" in reply.text
    assert "<code>" in reply.text


def test_video_from_stranger_is_ignored(monkeypatch):
    """file_id — ключ к файлу для нашего бота, посторонним он не выдаётся.
    Прежнее поведение для чужих медиа (молчать) не меняется."""
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    assert telegram_bot.build_reply(_video_update(12345)) is None


def test_photo_takes_the_largest_size(monkeypatch):
    """У фото Telegram присылает список размеров — нужен самый крупный."""
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    update = {"message": {
        "chat": {"type": "private"},
        "from": {"id": 999},
        "photo": [{"file_id": "SMALL"}, {"file_id": "BIG"}],
    }}
    reply = telegram_bot.build_reply(update)
    assert reply is not None and "BIG" in reply.text
