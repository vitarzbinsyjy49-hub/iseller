"""Тесты слоя отправки/редактирования (v5.6.0).

Прайс-посты обновляются пачкой по десятку сообщений, поэтому проверяется
главным образом устойчивость: 429 с retry_after, сетевые сбои, отличие
«нечего менять» от настоящей ошибки, и отсутствие секретов в логах.
"""
import json

import httpx
import pytest

from app.core import uploads
from app.core.config import settings
from app.services import telegram_publisher as tp


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_BOT_TOKEN", "test-token", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "@channel", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_PROXY_URL", "", raising=False)
    # Сон подменяем, иначе тест на backoff ждал бы по-настоящему.
    monkeypatch.setattr(tp, "_sleep", lambda seconds: None)


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.is_success = status_code < 400

    def json(self):
        return self._payload


def fake_post(responses: list):
    """Отдаёт заготовленные ответы по очереди, записывая отправленные payload.

    Обычные вызовы (json=) записываются как есть — большинство тестов читает
    payload прямо из sent[i]. Multipart-вызовы (files=) json не передают,
    поэтому для них в sent[i] попадает {"data": ..., "files": ...} —
    отличить легко: обычный payload это dict с "chat_id", а этот — с "data".
    """
    sent: list[dict] = []

    def _post(url, **kwargs):
        if kwargs.get("json") is not None:
            sent.append(kwargs.get("json"))
        else:
            sent.append({"data": kwargs.get("data"), "files": kwargs.get("files")})
        item = responses[min(len(sent) - 1, len(responses) - 1)]
        if isinstance(item, Exception):
            raise item
        return item

    _post.sent = sent
    return _post


OK = FakeResponse({"ok": True, "result": {"message_id": 42}})


# ---------------------------------------------------------------- отправка

def test_send_message_with_keyboard(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    keyboard = [[{"text": "🛍 Открыть раздел", "web_app": {"url": "https://a/catalog"}}]]
    message_id = tp.send_message(text="прайс", keyboard=keyboard)

    assert message_id == 42
    payload = post.sent[0]
    assert payload["reply_markup"] == {"inline_keyboard": keyboard}
    assert payload["parse_mode"] == "HTML"
    assert payload["disable_web_page_preview"] is True


def test_send_message_without_keyboard_omits_markup(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    tp.send_message(text="прайс")
    assert "reply_markup" not in post.sent[0]


def test_publishing_requires_channel(monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "", raising=False)
    with pytest.raises(tp.TelegramPublishError):
        tp.send_message(text="прайс")


# ---------------------------------------------------------------- редактирование

def test_edit_message_updates_existing_id(monkeypatch):
    post = fake_post([FakeResponse({"ok": True, "result": {"message_id": 7}})])
    monkeypatch.setattr(tp.httpx, "post", post)

    assert tp.edit_message(message_id=7, text="новый прайс") is True
    assert post.sent[0]["message_id"] == 7


def test_edit_returns_false_when_nothing_changed(monkeypatch):
    """Повторное обновление без изменений — норма, а не сбой."""
    post = fake_post([FakeResponse(
        {"ok": False, "description": "Bad Request: message is not modified"}, 400)])
    monkeypatch.setattr(tp.httpx, "post", post)
    assert tp.edit_message(message_id=7, text="то же самое") is False


def test_edit_raises_on_real_error(monkeypatch):
    post = fake_post([FakeResponse(
        {"ok": False, "description": "Bad Request: message to edit not found"}, 400)])
    monkeypatch.setattr(tp.httpx, "post", post)
    with pytest.raises(tp.TelegramPublishError, match="not found"):
        tp.edit_message(message_id=999, text="прайс")


def test_edit_reply_markup_only(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    keyboard = [[{"text": "📱 iPhone", "url": "https://t.me/c/1/2"}]]

    assert tp.edit_reply_markup(message_id=5, keyboard=keyboard) is True
    payload = post.sent[0]
    assert payload["reply_markup"] == {"inline_keyboard": keyboard}
    assert "text" not in payload      # текст навигационного поста не трогаем


# ---------------------------------------------------------------- 429 и сбои

def test_rate_limit_is_retried_after_the_requested_pause(monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr(tp, "_sleep", lambda s: slept.append(s))
    post = fake_post([
        FakeResponse({"ok": False, "description": "Too Many Requests",
                      "parameters": {"retry_after": 3}}, 429),
        OK,
    ])
    monkeypatch.setattr(tp.httpx, "post", post)

    assert tp.send_message(text="прайс") == 42
    assert slept == [3]


def test_long_rate_limit_surfaces_to_the_admin(monkeypatch):
    """Держать запрос админки минутами хуже, чем честно сказать «повторите позже»."""
    post = fake_post([FakeResponse(
        {"ok": False, "description": "Too Many Requests",
         "parameters": {"retry_after": tp.MAX_RETRY_AFTER + 5}}, 429)])
    monkeypatch.setattr(tp.httpx, "post", post)

    with pytest.raises(tp.TelegramRateLimited) as exc:
        tp.send_message(text="прайс")
    assert exc.value.retry_after == tp.MAX_RETRY_AFTER + 5


def test_network_failure_is_retried_then_reported(monkeypatch):
    post = fake_post([httpx.ConnectError("нет сети")])
    monkeypatch.setattr(tp.httpx, "post", post)

    with pytest.raises(tp.TelegramPublishError, match="unavailable"):
        tp.send_message(text="прайс")
    assert len(post.sent) == tp.MAX_ATTEMPTS


def test_network_failure_recovers_if_a_retry_succeeds(monkeypatch):
    post = fake_post([httpx.ConnectError("нет сети"), OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    assert tp.send_message(text="прайс") == 42


def test_business_errors_are_not_retried(monkeypatch):
    """«chat not found» от повтора не исправится — только жжём лимит."""
    post = fake_post([FakeResponse({"ok": False, "description": "Bad Request: chat not found"}, 400)])
    monkeypatch.setattr(tp.httpx, "post", post)

    with pytest.raises(tp.TelegramPublishError):
        tp.send_message(text="прайс")
    assert len(post.sent) == 1


def test_logs_do_not_contain_message_text_or_chat(monkeypatch, caplog):
    post = fake_post([FakeResponse({"ok": False, "description": "Bad Request: chat not found"}, 400)])
    monkeypatch.setattr(tp.httpx, "post", post)

    with caplog.at_level("WARNING"):
        with pytest.raises(tp.TelegramPublishError):
            tp.send_message(text="СЕКРЕТНЫЙ ТЕКСТ ПОСТА")

    logged = caplog.text
    assert "СЕКРЕТНЫЙ ТЕКСТ ПОСТА" not in logged
    assert "test-token" not in logged
    assert "chat not found" in logged      # причина сбоя видна


# ---------------------------------------------------------------- rich-сообщения (Bot API 10.1)

def test_send_rich_message_with_keyboard(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    keyboard = [[{"text": "🛍 Открыть раздел", "url": "https://t.me/bot?start=catalog"}]]
    message_id = tp.send_rich_message(html="<table><tr><td>A</td></tr></table>", keyboard=keyboard)

    assert message_id == 42
    payload = post.sent[0]
    assert payload["rich_message"] == {"html": "<table><tr><td>A</td></tr></table>"}
    assert payload["reply_markup"] == {"inline_keyboard": keyboard}
    assert "text" not in payload
    assert "parse_mode" not in payload


def test_send_rich_message_without_keyboard_omits_markup(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    tp.send_rich_message(html="<p>текст</p>")
    assert "reply_markup" not in post.sent[0]


def test_send_rich_message_rejects_oversized_html(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    with pytest.raises(tp.TelegramContentTooLong):
        tp.send_rich_message(html="x" * (tp.MAX_RICH_MESSAGE_LENGTH + 1))
    assert post.sent == []      # проверка длины — до сети, лимит не должен жечься зря


def test_edit_rich_message_updates_existing_id(monkeypatch):
    post = fake_post([FakeResponse({"ok": True, "result": {"message_id": 7}})])
    monkeypatch.setattr(tp.httpx, "post", post)

    assert tp.edit_rich_message(message_id=7, html="<h2>Обновлено</h2>") is True
    payload = post.sent[0]
    assert payload["message_id"] == 7
    assert payload["rich_message"] == {"html": "<h2>Обновлено</h2>"}


def test_edit_rich_message_returns_false_when_nothing_changed(monkeypatch):
    post = fake_post([FakeResponse(
        {"ok": False, "description": "Bad Request: message is not modified"}, 400)])
    monkeypatch.setattr(tp.httpx, "post", post)
    assert tp.edit_rich_message(message_id=7, html="<p>то же самое</p>") is False


def test_edit_rich_message_rejects_oversized_html(monkeypatch):
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)
    with pytest.raises(tp.TelegramContentTooLong):
        tp.edit_rich_message(message_id=7, html="x" * (tp.MAX_RICH_MESSAGE_LENGTH + 1))


# ---------------------------------------------------- относительные медиа-src в rich-контенте
#
# Telegram сам скачивает медиа rich-сообщения по URL из rich_message.html;
# относительный путь (как хранятся наши загрузки, /api/uploads/...) он
# резолвить не может и отвечает RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND — картинка
# беззвучно пропадает из уже опубликованного поста.

def test_send_rich_message_absolutizes_relative_image_src(monkeypatch):
    monkeypatch.setattr(settings, "MINI_APP_URL", "https://shop.example.com", raising=False)
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    tp.send_rich_message(html='<p>Гид</p><img src="/api/uploads/guide.png"/>')

    payload = post.sent[0]
    assert payload["rich_message"] == {
        "html": '<p>Гид</p><img src="https://shop.example.com/api/uploads/guide.png"/>'
    }


def test_send_rich_message_absolutizes_relative_video_and_audio_src(monkeypatch):
    monkeypatch.setattr(settings, "MINI_APP_URL", "https://shop.example.com", raising=False)
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    tp.send_rich_message(
        html='<video src="/api/uploads/a.mp4"></video><audio src="/api/uploads/b.mp3"></audio>'
    )

    payload = post.sent[0]
    assert payload["rich_message"]["html"] == (
        '<video src="https://shop.example.com/api/uploads/a.mp4"></video>'
        '<audio src="https://shop.example.com/api/uploads/b.mp3"></audio>'
    )


def test_send_rich_message_leaves_absolute_and_tg_src_untouched(monkeypatch):
    monkeypatch.setattr(settings, "MINI_APP_URL", "https://shop.example.com", raising=False)
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    html = '<img src="https://cdn.example.com/x.jpg"/><img src="tg://photo?id=abc"/>'
    tp.send_rich_message(html=html)

    assert post.sent[0]["rich_message"] == {"html": html}


def test_send_rich_message_without_mini_app_url_fails_before_sending(monkeypatch):
    monkeypatch.setattr(settings, "MINI_APP_URL", "", raising=False)
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    with pytest.raises(tp.TelegramPublishError):
        tp.send_rich_message(html='<img src="/api/uploads/guide.png"/>')
    assert post.sent == []      # относительный путь ловим до сети, не после


def test_edit_rich_message_absolutizes_relative_image_src(monkeypatch):
    monkeypatch.setattr(settings, "MINI_APP_URL", "https://shop.example.com", raising=False)
    post = fake_post([FakeResponse({"ok": True, "result": {"message_id": 7}})])
    monkeypatch.setattr(tp.httpx, "post", post)

    tp.edit_rich_message(message_id=7, html='<img src="/api/uploads/guide.png"/>')

    assert post.sent[0]["rich_message"] == {
        "html": '<img src="https://shop.example.com/api/uploads/guide.png"/>'
    }


# ---------------------------------------------------- multipart-загрузка своих файлов
#
# Живой A/B-тест на @isellerhub 19.08.2026: send_photo(photo=<URL на sslip.io>)
# отвечает "Bad Request: wrong type of the web page content" — Telegram
# принципиально отказывается сам скачивать медиа с этого домена. Тот же файл,
# отправленный multipart-загрузкой (файл в теле запроса, не ссылка) — 200 OK.
# Поэтому свои загрузки (/api/uploads/...) всегда уходят как файл, а не URL;
# внешние ссылки (чужой CDN) Telegram скачивает сам, как и раньше.

def test_send_photo_uploads_local_file_as_multipart(monkeypatch, tmp_path):
    monkeypatch.setattr(uploads, "UPLOAD_DIR", tmp_path)
    (tmp_path / "pic.png").write_bytes(b"\x89PNG-fake-bytes")
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    message_id = tp.send_photo(
        photo="https://shop.example.com/api/uploads/pic.png", caption="подпись",
    )

    assert message_id == 42
    sent = post.sent[0]
    filename, data, content_type = sent["files"]["photo"]
    assert data == b"\x89PNG-fake-bytes"
    assert content_type == "image/png"
    assert sent["data"]["caption"] == "подпись"
    assert "photo" not in sent["data"]      # файл ушёл как файл, не строкой-URL


def test_send_photo_local_upload_sends_keyboard_as_json_string(monkeypatch, tmp_path):
    """multipart/form-data не сериализует dict сам — reply_markup должен уйти
    JSON-строкой, как этого требует Bot API, а не питоньим dict."""
    monkeypatch.setattr(uploads, "UPLOAD_DIR", tmp_path)
    (tmp_path / "pic.png").write_bytes(b"x")
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    keyboard = [[{"text": "Открыть", "url": "https://t.me/bot?start=x"}]]
    tp.send_photo(photo="/api/uploads/pic.png", caption="c", keyboard=keyboard)

    raw = post.sent[0]["data"]["reply_markup"]
    assert isinstance(raw, str)
    assert json.loads(raw) == {"inline_keyboard": keyboard}


def test_send_photo_sends_url_directly_for_external_photo(monkeypatch, tmp_path):
    """Внешний CDN не наш файл — Telegram и раньше умел его скачивать сам."""
    monkeypatch.setattr(uploads, "UPLOAD_DIR", tmp_path)      # локальных файлов нет
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    tp.send_photo(photo="https://cdn.example.com/pic.jpg", caption="c")

    payload = post.sent[0]
    assert payload["photo"] == "https://cdn.example.com/pic.jpg"
    assert "files" not in payload


def test_send_rich_message_uploads_local_image_via_multipart(monkeypatch, tmp_path):
    monkeypatch.setattr(uploads, "UPLOAD_DIR", tmp_path)
    (tmp_path / "guide.png").write_bytes(b"fake-png-bytes")
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    tp.send_rich_message(html='<p>Гид</p><img src="/api/uploads/guide.png"/>')

    sent = post.sent[0]
    rich_message = json.loads(sent["data"]["rich_message"])
    assert "/api/uploads/guide.png" not in rich_message["html"]
    assert "tg://photo?id=" in rich_message["html"]
    [media_item] = rich_message["media"]
    assert media_item["media"]["type"] == "photo"
    attach_name = media_item["media"]["media"].removeprefix("attach://")
    assert sent["files"][attach_name][1] == b"fake-png-bytes"


def test_send_rich_message_local_media_does_not_require_mini_app_url(monkeypatch, tmp_path):
    """Multipart грузит байты напрямую — в отличие от старого URL-пути, ему
    не нужен MINI_APP_URL, чтобы построить абсолютную ссылку."""
    monkeypatch.setattr(settings, "MINI_APP_URL", "", raising=False)
    monkeypatch.setattr(uploads, "UPLOAD_DIR", tmp_path)
    (tmp_path / "guide.png").write_bytes(b"data")
    post = fake_post([OK])
    monkeypatch.setattr(tp.httpx, "post", post)

    tp.send_rich_message(html='<img src="/api/uploads/guide.png"/>')      # не должно упасть

    assert "files" in post.sent[0]


def test_edit_rich_message_uploads_local_image_via_multipart(monkeypatch, tmp_path):
    monkeypatch.setattr(uploads, "UPLOAD_DIR", tmp_path)
    (tmp_path / "guide.png").write_bytes(b"bytes")
    post = fake_post([FakeResponse({"ok": True, "result": {"message_id": 7}})])
    monkeypatch.setattr(tp.httpx, "post", post)

    assert tp.edit_rich_message(message_id=7, html='<img src="/api/uploads/guide.png"/>') is True

    sent = post.sent[0]
    assert sent["data"]["message_id"] == 7
    assert "files" in sent


# ---------------------------------------------------------------- альбом

def test_send_media_group_puts_caption_only_on_first(monkeypatch, tmp_path):
    """Подпись у альбома одна. Если поставить её каждому элементу, клиент
    нарисует один и тот же текст под каждой фотографией."""
    post = fake_post([FakeResponse({"ok": True, "result": [
        {"message_id": 11}, {"message_id": 12}, {"message_id": 13},
    ]})])
    monkeypatch.setattr(tp.httpx, "post", post)
    monkeypatch.setattr(uploads, "local_path_for_url", lambda url: None)

    ids = tp.send_media_group(
        photos=["https://cdn/a.jpg", "https://cdn/b.jpg", "https://cdn/c.jpg"],
        caption="Фото с нашего склада",
    )

    assert ids == [11, 12, 13]
    media = post.sent[0]["media"]
    assert media[0]["caption"] == "Фото с нашего склада"
    assert "caption" not in media[1] and "caption" not in media[2]


def test_send_media_group_uploads_our_files_as_bytes(monkeypatch, tmp_path):
    """Своя загрузка уходит байтами через attach:// — с нашего домена Telegram
    медиа сам не забирает (см. docs/context/channel-posts.md)."""
    photo = tmp_path / "sklad.jpg"
    photo.write_bytes(b"\xff\xd8\xffmock")
    post = fake_post([FakeResponse({"ok": True, "result": [
        {"message_id": 1}, {"message_id": 2},
    ]})])
    monkeypatch.setattr(tp.httpx, "post", post)
    monkeypatch.setattr(uploads, "local_path_for_url",
                        lambda url: photo if url.startswith("/api/uploads") else None)

    tp.send_media_group(photos=["/api/uploads/sklad.jpg", "https://cdn/b.jpg"])

    call = post.sent[0]
    assert "photo0" in call["files"]                       # наш файл — вложением
    media = json.loads(call["data"]["media"])
    assert media[0]["media"] == "attach://photo0"
    assert media[1]["media"] == "https://cdn/b.jpg"        # чужой CDN — ссылкой


@pytest.mark.parametrize("count", [0, 1, 11])
def test_send_media_group_rejects_impossible_sizes(monkeypatch, count):
    """Bot API принимает от 2 до 10 медиа; ловим это до сети, а не отказом."""
    monkeypatch.setattr(tp.httpx, "post", fake_post([OK]))
    with pytest.raises(tp.TelegramPublishError):
        tp.send_media_group(photos=["https://cdn/a.jpg"] * count)
