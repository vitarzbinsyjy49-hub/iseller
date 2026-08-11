"""Тесты инфо-постов канала (v5.7.0).

Главное отличие от прайса: текст пишет человек, а не генератор. Отсюда два
свойства, которые здесь и защищаются — повторная генерация не затирает
написанное, и незаполненная заготовка не уходит в канал.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin
from app.core.config import settings
from app.db.session import get_db
from app.main import app
from app.models.post import ChannelPost
from app.services import price_channel
from app.services.info_posts import (
    INFO_BY_SLUG,
    INFO_KIND,
    INFO_POSTS,
    PLACEHOLDER,
    has_placeholders,
    info_keyboard,
)
from app.services.telegram_publisher import TelegramPublishError


@pytest.fixture(autouse=True)
def channel_settings(monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "-1003998743702", raising=False)
    monkeypatch.setattr(settings, "MINI_APP_URL", "https://shop.example.com", raising=False)
    monkeypatch.setattr(settings, "MANAGER_RETAIL_URL", "https://t.me/iseller77", raising=False)
    monkeypatch.setattr(settings, "BOT_USERNAME", "isellerAIbot", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_BOT_TOKEN", "test-token", raising=False)


class FakeTelegram:
    def __init__(self):
        self.sent, self.edited = [], []
        self.next_id = 200

    def send_message(self, *, text, keyboard=None, channel_id=None, **kw):
        self.next_id += 1
        self.sent.append({"text": text, "keyboard": keyboard, "message_id": self.next_id})
        return self.next_id

    def edit_message(self, *, message_id, text, keyboard=None, channel_id=None):
        self.edited.append({"message_id": message_id, "text": text})
        return True

    def edit_reply_markup(self, *, message_id, keyboard, channel_id=None):
        return True


@pytest.fixture()
def telegram(monkeypatch):
    fake = FakeTelegram()
    monkeypatch.setattr(price_channel, "send_message", fake.send_message)
    monkeypatch.setattr(price_channel, "edit_message", fake.edit_message)
    monkeypatch.setattr(price_channel, "edit_reply_markup", fake.edit_reply_markup)
    return fake


def fill(db, slug: str, text: str = "Готовый текст без пропусков.") -> ChannelPost:
    row = db.query(ChannelPost).filter_by(slug=slug).one()
    row.body = text
    db.commit()
    return row


# ---------------------------------------------------------------- заготовки

def test_drafts_are_created_for_every_info_post(db):
    created = price_channel.ensure_info_drafts(db)
    assert {row.slug for row in created} == {info.slug for info in INFO_POSTS}
    assert all(row.status == "draft" and row.telegram_message_id is None for row in created)


def test_repeated_generation_does_not_overwrite_written_text(db):
    """Текст инфо-поста пишет человек — повторный вызов не должен его затирать."""
    price_channel.ensure_info_drafts(db)
    fill(db, "info_warranty", "Наши настоящие условия гарантии.")

    price_channel.ensure_info_drafts(db)

    row = db.query(ChannelPost).filter_by(slug="info_warranty").one()
    assert row.body == "Наши настоящие условия гарантии."


def test_drafts_are_filled_and_ready():
    """Заготовки описывают РЕАЛЬНЫЕ условия магазина и публикуются как есть.

    Раньше половина заготовок намеренно шла с «[уточнить]»: условий доставки,
    оплаты и возврата проект не знал. Владелец их назвал, и незаполненных мест
    не осталось. Проверка обратная по смыслу, но защищает то же самое — что в
    канал не уедет черновик.
    """
    for info in INFO_POSTS:
        assert not has_placeholders(info.default_text), info.slug


def test_drafts_promise_only_what_the_shop_does():
    """Сроки и тарифы не называются, гарантия совпадает с каталогом (1 месяц)."""
    by_slug = {info.slug: info for info in INFO_POSTS}

    about = by_slug["info_about"]
    assert "1 месяц" in about.default_text
    assert "Горбушки" in about.default_text
    # Прежний срок из первых версий не должен вернуться ни в один пост:
    # в карточке товара стоит warranty_months=1, и две разные правды об одном
    # обязательстве хуже, чем одна скучная.
    for info in INFO_POSTS:
        assert "14 дней" not in info.default_text, info.slug

    # Доставку и возврат определяет человек — пост обязан отправлять к нему,
    # а не называть срок, которого магазин не обещал.
    assert "менеджер" in by_slug["info_delivery"].default_text.lower()
    assert "менеджер" in by_slug["info_returns"].default_text.lower()


# ---------------------------------------------------------------- публикация

def test_unfilled_post_is_not_published(db, telegram):
    """«[уточнить]» в канале читается как забытый черновик.

    Заготовки теперь заполнены целиком, поэтому незаполненное место вносим
    сами: проверяется предохранитель, а не конкретный раздел. Иначе тест
    молча перестал бы что-либо проверять, как только тексты дописали.
    """
    price_channel.ensure_info_drafts(db)
    fill(db, "info_warranty", f"🛡 Гарантия. Возврат: {PLACEHOLDER} — впишите условия.")

    result = price_channel.apply_info_posts(db)

    assert telegram.sent == [] or all(
        PLACEHOLDER not in item["text"] for item in telegram.sent)
    failed = {slug for slug, _ in result.failed}
    assert "info_warranty" in failed
    assert "info_about" in result.created          # готовый — публикуется


def test_filled_post_is_published_with_buttons(db, telegram):
    price_channel.ensure_info_drafts(db)
    fill(db, "info_warranty", "🛡 Гарантия 14 дней. Проверка при вас.")

    result = price_channel.apply_info_posts(db, slugs=["info_warranty"])

    assert result.created == ["info_warranty"]
    sent = telegram.sent[-1]
    assert sent["text"] == "🛡 Гарантия 14 дней. Проверка при вас."
    labels = [b["text"] for row in sent["keyboard"] for b in row]
    assert labels == ["🛍 Открыть каталог", "💬 Задать вопрос менеджеру"]


def test_deleted_message_is_republished_next_run(db, telegram, monkeypatch):
    """Пост, удалённый из канала руками, не залипает в ошибке навсегда.

    Реальный случай: сообщение info_pin_catalog удалили, а message_id остался
    в базе — и каждая публикация пыталась править то, чего нет. Забываем id,
    и следующий запуск отправляет пост заново.
    """
    price_channel.ensure_info_drafts(db)
    fill(db, "info_about", "Текст поста.")
    price_channel.apply_info_posts(db, slugs=["info_about"])
    published_id = db.query(ChannelPost).filter_by(slug="info_about").one().telegram_message_id
    assert published_id is not None

    def gone(**kw):
        raise TelegramPublishError("Bad Request: message to edit not found")

    monkeypatch.setattr(price_channel, "edit_message", gone)
    fill(db, "info_about", "Изменённый текст.")
    result = price_channel.apply_info_posts(db, slugs=["info_about"])

    assert [slug for slug, _ in result.failed] == ["info_about"]
    assert db.query(ChannelPost).filter_by(slug="info_about").one().telegram_message_id is None

    # Следующий запуск — уже обычная отправка, без ручного вмешательства.
    monkeypatch.setattr(price_channel, "edit_message", telegram.edit_message)
    again = price_channel.apply_info_posts(db, slugs=["info_about"])
    assert again.created == ["info_about"]
    assert telegram.sent[-1]["text"] == "Изменённый текст."


def test_lost_edit_rights_keeps_message_id(db, telegram, monkeypatch):
    """Другая ошибка правки id НЕ сбрасывает — иначе в канале появится дубль."""
    price_channel.ensure_info_drafts(db)
    fill(db, "info_about", "Текст поста.")
    price_channel.apply_info_posts(db, slugs=["info_about"])

    def forbidden(**kw):
        raise TelegramPublishError("Forbidden: not enough rights to edit a message")

    monkeypatch.setattr(price_channel, "edit_message", forbidden)
    fill(db, "info_about", "Изменённый текст.")
    price_channel.apply_info_posts(db, slugs=["info_about"])

    assert db.query(ChannelPost).filter_by(slug="info_about").one().telegram_message_id is not None


def test_info_buttons_are_url_only(db):
    """В канале web_app-кнопки запрещены (BUTTON_TYPE_INVALID)."""
    keyboard = info_keyboard("https://shop.example.com", "https://t.me/m", "isellerAIbot")
    for row in keyboard:
        for button in row:
            assert "web_app" not in button
            assert button["url"].startswith("https://")


def test_second_publish_edits_the_same_message(db, telegram):
    price_channel.ensure_info_drafts(db)
    fill(db, "info_warranty", "Первая версия.")
    price_channel.apply_info_posts(db, slugs=["info_warranty"])
    message_id = db.query(ChannelPost).filter_by(slug="info_warranty").one().telegram_message_id

    fill(db, "info_warranty", "Исправленная версия.")
    result = price_channel.apply_info_posts(db, slugs=["info_warranty"])

    assert result.updated == ["info_warranty"]
    assert telegram.edited[-1]["message_id"] == message_id
    assert telegram.edited[-1]["text"] == "Исправленная версия."
    assert len(telegram.sent) == 1


def test_dry_run_sends_nothing(db, telegram):
    price_channel.ensure_info_drafts(db)
    fill(db, "info_warranty", "Готово.")
    result = price_channel.apply_info_posts(db, slugs=["info_warranty"], dry_run=True)
    assert result.created == ["info_warranty"]
    assert telegram.sent == []


def test_publishing_requires_channel(db, telegram, monkeypatch):
    price_channel.ensure_info_drafts(db)
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "", raising=False)
    with pytest.raises(TelegramPublishError):
        price_channel.apply_info_posts(db)


# ---------------------------------------------------------------- навигация

def test_navigation_lists_info_posts_after_price_sections(db, telegram):
    """Человек приходит в канал за ценой, условия читает вторым шагом."""
    from app.models.product import Product

    db.add(Product(title="Apple iPhone 17", brand="Apple", category="смартфоны",
                   subcategory="iPhone", price=89500, is_active=True, sku="IP-1"))
    db.commit()
    price_channel.apply_plan(db)
    price_channel.ensure_info_drafts(db)
    fill(db, "info_warranty", "Гарантия 14 дней.")
    price_channel.apply_info_posts(db, slugs=["info_warranty"])
    price_channel.sync_navigation(db)

    labels = [row[0]["text"] for row in telegram.sent[-1]["keyboard"]]
    assert labels.index("📱 iPhone") < labels.index("🛡 Гарантия и проверка")


def test_unpublished_info_post_gets_no_navigation_button(db, telegram):
    price_channel.ensure_info_drafts(db)
    price_channel.sync_navigation(db)
    labels = [row[0]["text"] for row in telegram.sent[-1]["keyboard"]]
    assert not any("Гарантия" in label for label in labels)


# ---------------------------------------------------------------- API

@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_admin] = lambda: "admin:test"
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_api_reset_returns_draft_from_code(client, db, telegram):
    """«Вернуть заготовку» — явное «да, возьми версию из кода».

    Генерация чужие правки не трогает и трогать не должна. Но когда заготовку
    в коде переписали, вернуть её было нечем, кроме копипаста HTML в поле.
    """
    client.post("/api/admin/price-posts/info/generate")
    fill(db, "info_payment", "Старый текст с [уточнить].")

    response = client.post("/api/admin/price-posts/info/info_payment/reset")

    assert response.status_code == 200
    row = db.query(ChannelPost).filter_by(slug="info_payment").one()
    assert row.body == INFO_BY_SLUG["info_payment"].default_text
    assert PLACEHOLDER not in row.body


def test_api_reset_marks_published_post_outdated(client, db, telegram):
    """Опубликованный пост после сброса расходится с каналом — как при правке."""
    client.post("/api/admin/price-posts/info/generate")
    price_channel.apply_info_posts(db, slugs=["info_about"])
    fill(db, "info_about", "Совсем другой текст.")

    client.post("/api/admin/price-posts/info/info_about/reset")

    assert db.query(ChannelPost).filter_by(slug="info_about").one().status == "outdated"


def test_api_reset_refuses_post_without_draft(client, db):
    """Свой пост из админки возвращать не к чему — заготовки у него нет."""
    client.post("/api/admin/price-posts/info",
                json={"slug": "info_custom", "title": "Свой", "body": "Текст"})

    assert client.post("/api/admin/price-posts/info/info_custom/reset").status_code == 404


def test_api_generate_and_edit(client, db, telegram):
    response = client.post("/api/admin/price-posts/info/generate")
    assert response.status_code == 200
    assert len(response.json()["created"]) == len(INFO_POSTS)

    edited = client.patch("/api/admin/price-posts/info/info_payment",
                          json={"body": "Оплата наличными и переводом."})
    assert edited.status_code == 200
    assert edited.json()["has_placeholders"] is False
    assert db.query(ChannelPost).filter_by(slug="info_payment").one().body \
        == "Оплата наличными и переводом."


def test_api_edit_marks_published_post_outdated(client, db, telegram):
    client.post("/api/admin/price-posts/info/generate")
    fill(db, "info_about", "Версия 1.")
    price_channel.apply_info_posts(db, slugs=["info_about"])

    client.patch("/api/admin/price-posts/info/info_about", json={"body": "Версия 2."})
    assert db.query(ChannelPost).filter_by(slug="info_about").one().status == "outdated"


def test_api_publish_requires_confirmation(client, db, telegram):
    client.post("/api/admin/price-posts/info/generate")
    response = client.post("/api/admin/price-posts/info/publish", json={"confirm": False})
    assert response.status_code == 400
    assert telegram.sent == []


def test_api_edit_unknown_post_is_404(client):
    assert client.patch("/api/admin/price-posts/info/info_nope",
                        json={"body": "x"}).status_code == 404


# ---------------------------------------------------------------- кнопки

def test_button_spec_resolves_to_urls(db):
    from app.services.info_posts import build_keyboard

    keyboard = build_keyboard(
        [
            {"text": "Каталог", "kind": "catalog", "row": 0},
            {"text": "Менеджер", "kind": "manager", "row": 0},
            {"text": "Сайт", "kind": "url", "value": "https://example.com", "row": 1},
        ],
        bot_username="isellerAIbot", manager_url="https://t.me/iseller77",
        channel_url="https://t.me/isellerhub",
    )
    assert [len(row) for row in keyboard] == [2, 1]
    assert keyboard[0][0]["url"] == "https://t.me/isellerAIbot?start=catalog"
    assert keyboard[0][1]["url"] == "https://t.me/iseller77"
    assert keyboard[1][0]["url"] == "https://example.com"


def test_section_button_points_at_published_post(db):
    """Кнопка «Раздел прайса» ведёт в канал, если пост уже опубликован."""
    from app.services.info_posts import build_keyboard

    keyboard = build_keyboard(
        [{"text": "iPhone", "kind": "section", "value": "price_iphone"}],
        bot_username="isellerAIbot", manager_url="", channel_url="",
        section_links={"price_iphone": "https://t.me/c/399/5"},
    )
    assert keyboard[0][0]["url"] == "https://t.me/c/399/5"


def test_section_button_falls_back_to_the_bot(db):
    """Раздел ещё не опубликован — кнопка ведёт в бота, а не исчезает."""
    from app.services.info_posts import build_keyboard

    keyboard = build_keyboard(
        [{"text": "iPhone", "kind": "section", "value": "price_iphone"}],
        bot_username="isellerAIbot", manager_url="", channel_url="", section_links={})
    assert keyboard[0][0]["url"] == "https://t.me/isellerAIbot?start=price_iphone"


def test_unresolvable_button_is_dropped_not_fatal(db):
    """Пустой url валит ВСЁ сообщение — такую кнопку выбрасываем."""
    from app.services.info_posts import build_keyboard

    keyboard = build_keyboard(
        [{"text": "Канал", "kind": "channel"}, {"text": "Каталог", "kind": "catalog", "row": 0}],
        bot_username="isellerAIbot", manager_url="", channel_url="")
    labels = [b["text"] for row in keyboard for b in row]
    assert labels == ["Каталог"]


def test_buttons_are_stored_as_spec_not_frozen_urls(db, telegram, monkeypatch):
    """Сменился менеджер — посты подхватывают новую ссылку без перезаписи."""
    price_channel.ensure_info_drafts(db)
    fill(db, "info_about", "Текст.")
    price_channel.apply_info_posts(db, slugs=["info_about"])
    assert telegram.sent[-1]["keyboard"][1][0]["url"] == "https://t.me/iseller77"

    monkeypatch.setattr(settings, "MANAGER_RETAIL_URL", "https://t.me/newmanager", raising=False)
    price_channel.apply_info_posts(db, slugs=["info_about"])
    assert telegram.edited[-1]["message_id"]
    row = db.query(ChannelPost).filter_by(slug="info_about").one()
    assert row.reply_markup[1][0]["url"] == "https://t.me/newmanager"


def test_api_create_custom_post(client, db, telegram):
    response = client.post("/api/admin/price-posts/info", json={
        "slug": "info_promo", "title": "Акция",
        "body": "🔥 <b>Акция недели</b>\nСкидки на аксессуары.",
        "buttons": [{"text": "Каталог", "kind": "catalog", "row": 0}],
    })
    assert response.status_code == 200
    assert response.json()["slug"] == "info_promo"
    assert db.query(ChannelPost).filter_by(slug="info_promo").one().kind == INFO_KIND


def test_api_rejects_duplicate_slug(client, db, telegram):
    payload = {"slug": "info_promo", "title": "A", "body": "b"}
    assert client.post("/api/admin/price-posts/info", json=payload).status_code == 200
    assert client.post("/api/admin/price-posts/info", json=payload).status_code == 409


def test_api_rejects_bad_slug(client):
    assert client.post("/api/admin/price-posts/info", json={
        "slug": "плохой слаг!", "title": "A", "body": "b"}).status_code == 400
