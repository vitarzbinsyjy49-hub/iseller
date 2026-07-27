"""Тесты Telegram-бота (v5.5.0): разбор команд, ответы, вебхук.

Контракт:
- POST /api/telegram/webhook  — приём апдейтов, защищён secret_token в заголовке
  X-Telegram-Bot-Api-Secret-Token; ВСЕГДА отвечает 200 при верном секрете.

Ключевое свойство, которое проверяется отдельно: вебхук не отдаёт 5xx на
внутренней ошибке. Telegram повторяет доставку, пока не увидит успех, поэтому
5xx означал бы дубли ответов пользователю, а не «починимся позже».
"""
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
    monkeypatch.setattr(telegram_bot, "send_reply", lambda chat_id, reply: sent.append((chat_id, reply)))
    monkeypatch.setattr("app.api.telegram.send_reply", lambda chat_id, reply: sent.append((chat_id, reply)))
    r = client.post("/api/telegram/webhook", json=private_message("/start", chat_id=777),
                    headers={"X-Telegram-Bot-Api-Secret-Token": SECRET})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert len(sent) == 1
    chat_id, reply = sent[0]
    assert chat_id == 777
    assert reply.text.startswith("Добро пожаловать")


def test_webhook_answers_200_even_if_sending_fails(client, monkeypatch):
    """Иначе Telegram будет ретраить и пользователь получит дубли ответов."""
    def boom(chat_id, reply):
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
    def boom(chat_id, reply):
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
