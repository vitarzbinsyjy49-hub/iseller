"""Тесты оркестрации прайс-постов (v5.6.0): БД + Telegram.

Здесь защищаются свойства, ошибки в которых видно только в боевом канале:
идемпотентность (повторный прогон не плодит дубли), редактирование на том же
message_id, сохранение уже полученных id при частичном сбое и запрет любых
отправок без подтверждения администратора.
"""
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin
from app.core.config import settings
from app.db.session import get_db
from app.main import app
from app.models.post import ChannelPost
from app.models.product import Product
from app.services import price_channel
from app.services.marketplace import MARKETPLACE_SOURCE
from app.services.price_posts import NAVIGATION_SLUG
from app.services.telegram_publisher import TelegramPublishError

TODAY = date(2026, 7, 28)


@pytest.fixture(autouse=True)
def channel_settings(monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "-1003998743702", raising=False)
    monkeypatch.setattr(settings, "MINI_APP_URL", "https://shop.example.com", raising=False)
    monkeypatch.setattr(settings, "MANAGER_RETAIL_URL", "https://t.me/iseller77", raising=False)
    monkeypatch.setattr(settings, "TELEGRAM_BOT_TOKEN", "test-token", raising=False)


@pytest.fixture()
def catalog(db):
    """Небольшой каталог: два раздела, чтобы проверять частичные операции."""
    items = [
        Product(title="Apple iPhone 17 256 Blue", brand="Apple", category="смартфоны",
                subcategory="iPhone", price=89500, is_active=True, sku="IP-1"),
        Product(title="Apple iPhone 17 512 Black", brand="Apple", category="смартфоны",
                subcategory="iPhone", price=99500, is_active=True, sku="IP-2"),
        Product(title="Apple AirPods 4", brand="Apple", category="наушники",
                subcategory="AirPods", price=9500, is_active=True, sku="AP-1"),
    ]
    for item in items:
        db.add(item)
    db.commit()
    return items


class FakeTelegram:
    """Учёт всех обращений к Telegram: что отправлено, что отредактировано."""

    def __init__(self):
        self.sent: list[dict] = []
        self.edited: list[dict] = []
        self.markup_edits: list[dict] = []
        self.next_id = 100
        self.fail_after: int | None = None

    def send_message(self, *, text, keyboard=None, channel_id=None, **kw):
        if self.fail_after is not None and len(self.sent) >= self.fail_after:
            raise TelegramPublishError("Too Many Requests")
        self.next_id += 1
        self.sent.append({"text": text, "keyboard": keyboard, "message_id": self.next_id})
        return self.next_id

    def edit_message(self, *, message_id, text, keyboard=None, channel_id=None):
        self.edited.append({"message_id": message_id, "text": text, "keyboard": keyboard})
        return True

    def edit_reply_markup(self, *, message_id, keyboard, channel_id=None):
        self.markup_edits.append({"message_id": message_id, "keyboard": keyboard})
        return True


@pytest.fixture()
def telegram(monkeypatch):
    fake = FakeTelegram()
    monkeypatch.setattr(price_channel, "send_message", fake.send_message)
    monkeypatch.setattr(price_channel, "edit_message", fake.edit_message)
    monkeypatch.setattr(price_channel, "edit_reply_markup", fake.edit_reply_markup)
    return fake


# ---------------------------------------------------------------- план

def test_plan_marks_everything_as_create_on_empty_channel(db, catalog):
    plans = price_channel.build_plan(db, TODAY)
    assert {p.action for p in plans} == {"create"}
    assert {p.slug for p in plans} == {"price_iphone", "price_airpods"}


def test_plan_is_unchanged_right_after_publishing(db, catalog, telegram):
    price_channel.apply_plan(db, on_date=TODAY)
    plans = price_channel.build_plan(db, TODAY)
    assert {p.action for p in plans} == {"unchanged"}


def test_plan_detects_price_change(db, catalog, telegram):
    price_channel.apply_plan(db, on_date=TODAY)
    catalog[0].price = 87000
    db.commit()

    plans = {p.slug: p for p in price_channel.build_plan(db, TODAY)}
    iphone = plans["price_iphone"]
    assert iphone.action == "update"
    assert iphone.price_changes == [("iPhone 17 256 Blue", 89500.0, 87000.0)]


def test_plan_reports_added_and_removed(db, catalog, telegram):
    price_channel.apply_plan(db, on_date=TODAY)
    catalog[1].is_active = False
    db.add(Product(title="Apple iPhone 17 Pro", brand="Apple", category="смартфоны",
                   subcategory="iPhone", price=120000, is_active=True, sku="IP-3"))
    db.commit()

    iphone = {p.slug: p for p in price_channel.build_plan(db, TODAY)}["price_iphone"]
    assert iphone.added == ["iPhone 17 Pro"]
    assert iphone.removed == ["iPhone 17 512 Black"]


# ---------------------------------------------------------------- публикация

def test_publish_creates_posts_and_stores_message_ids(db, catalog, telegram):
    result = price_channel.apply_plan(db, on_date=TODAY)

    assert sorted(result.created) == ["price_airpods", "price_iphone"]
    assert len(telegram.sent) == 2
    rows = {r.slug: r for r in db.query(ChannelPost).all()}
    for slug in ("price_iphone", "price_airpods"):
        assert rows[slug].telegram_message_id is not None
        assert rows[slug].status == "published"
        assert rows[slug].channel_id == "-1003998743702"


def test_second_run_edits_instead_of_publishing_again(db, catalog, telegram):
    """Главное свойство системы: пост публикуется один раз, дальше правится."""
    price_channel.apply_plan(db, on_date=TODAY)
    first_ids = [r.telegram_message_id for r in db.query(ChannelPost).all()]

    catalog[0].price = 87000
    db.commit()
    result = price_channel.apply_plan(db, on_date=TODAY)

    assert result.updated == ["price_iphone"]
    assert len(telegram.sent) == 2                 # новых сообщений не появилось
    assert len(telegram.edited) == 1
    assert telegram.edited[0]["message_id"] in first_ids
    # message_id не изменился — подписчики видят тот же пост.
    assert [r.telegram_message_id for r in db.query(ChannelPost).all()] == first_ids


def test_repeated_run_without_changes_sends_nothing(db, catalog, telegram):
    price_channel.apply_plan(db, on_date=TODAY)
    result = price_channel.apply_plan(db, on_date=TODAY)

    assert sorted(result.unchanged) == ["price_airpods", "price_iphone"]
    assert len(telegram.edited) == 0
    assert len(telegram.sent) == 2


def test_partial_failure_keeps_already_published_ids(db, catalog, telegram):
    """Если пачка упала на середине, повторный прогон не должен плодить дубли."""
    telegram.fail_after = 1
    result = price_channel.apply_plan(db, on_date=TODAY)

    assert len(result.created) == 1
    assert len(result.failed) == 1
    published = [r for r in db.query(ChannelPost).all() if r.telegram_message_id]
    assert len(published) == 1                     # id уцелел, несмотря на сбой

    # Повторяем: успешный пост не публикуется заново.
    telegram.fail_after = None
    second = price_channel.apply_plan(db, on_date=TODAY)
    assert len(second.created) == 1
    assert len(telegram.sent) == 2
    assert len({r.telegram_message_id for r in db.query(ChannelPost).all()}) == 2


def test_failure_is_recorded_on_the_post(db, catalog, telegram):
    telegram.fail_after = 0
    price_channel.apply_plan(db, on_date=TODAY)
    rows = [r for r in db.query(ChannelPost).all() if r.status == "error"]
    assert rows and "Too Many Requests" in (rows[0].last_error or "")


def test_deleted_price_post_is_republished_next_run(db, catalog, telegram, monkeypatch):
    """Прайс-пост, удалённый из канала руками, не залипает в ошибке навсегда.

    Реальный случай на проде: price_iphone_p3 удалили из канала, message_id
    остался в базе — каждая правка пыталась редактировать то, чего нет, и
    статус молча оставался «published». Та же защита, что у
    apply_info_posts (test_info_posts.py::test_deleted_message_is_republished_next_run),
    только apply_plan её раньше не имел вовсе."""
    price_channel.apply_plan(db, on_date=TODAY, slugs=["price_iphone"])
    published_id = db.query(ChannelPost).filter_by(slug="price_iphone").one().telegram_message_id
    assert published_id is not None

    def gone(**kw):
        raise TelegramPublishError("Bad Request: message to edit not found")

    monkeypatch.setattr(price_channel, "edit_message", gone)
    catalog[0].price = 87000
    db.commit()
    result = price_channel.apply_plan(db, on_date=TODAY, slugs=["price_iphone"])

    assert [slug for slug, _ in result.failed] == ["price_iphone"]
    assert db.query(ChannelPost).filter_by(slug="price_iphone").one().telegram_message_id is None

    # Следующий запуск — уже обычная отправка, без ручного вмешательства.
    monkeypatch.setattr(price_channel, "edit_message", telegram.edit_message)
    again = price_channel.apply_plan(db, on_date=TODAY, slugs=["price_iphone"])
    assert again.created == ["price_iphone"]
    assert db.query(ChannelPost).filter_by(slug="price_iphone").one().telegram_message_id is not None


def test_dry_run_touches_nothing(db, catalog, telegram):
    result = price_channel.apply_plan(db, on_date=TODAY, dry_run=True)

    assert sorted(result.created) == ["price_airpods", "price_iphone"]
    assert telegram.sent == [] and telegram.edited == []
    assert db.query(ChannelPost).count() == 0


def test_publishing_only_selected_slugs(db, catalog, telegram):
    price_channel.apply_plan(db, on_date=TODAY, slugs=["price_iphone"])
    assert len(telegram.sent) == 1
    slugs = {r.slug for r in db.query(ChannelPost).all() if r.telegram_message_id}
    assert slugs == {"price_iphone"}


def test_publishing_requires_channel_id(db, catalog, telegram, monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_CHANNEL_ID", "", raising=False)
    with pytest.raises(TelegramPublishError):
        price_channel.apply_plan(db, on_date=TODAY)


# ---------------------------------------------------------------- превью

def test_generate_preview_creates_drafts_without_publishing(db, catalog, telegram):
    rows = price_channel.save_preview(db, TODAY)
    assert len(rows) == 2
    assert all(r.status == "draft" and r.telegram_message_id is None for r in rows)
    assert telegram.sent == []


def test_preview_does_not_overwrite_published_text(db, catalog, telegram):
    """body хранит то, что реально лежит в канале, — иначе diff станет ложным."""
    price_channel.apply_plan(db, on_date=TODAY)
    published_text = db.query(ChannelPost).filter_by(slug="price_iphone").one().body

    catalog[0].price = 87000
    db.commit()
    price_channel.save_preview(db, TODAY)

    row = db.query(ChannelPost).filter_by(slug="price_iphone").one()
    assert row.body == published_text          # текст в канале не подменён
    assert row.status == "outdated"            # но видно, что пост устарел


# ---------------------------------------------------------------- навигация

def test_navigation_lists_published_sections_only(db, catalog, telegram):
    price_channel.apply_plan(db, on_date=TODAY, slugs=["price_iphone"])
    price_channel.sync_navigation(db, on_date=TODAY)

    nav_keyboard = telegram.sent[-1]["keyboard"]
    labels = [row[0]["text"] for row in nav_keyboard]
    assert any("iPhone" in label for label in labels)
    assert not any("AirPods" in label for label in labels)


def test_navigation_updates_markup_instead_of_reposting(db, catalog, telegram):
    """Перепубликация подняла бы новое уведомление и сбила закреп."""
    price_channel.apply_plan(db, on_date=TODAY, slugs=["price_iphone"])
    price_channel.sync_navigation(db, on_date=TODAY)
    nav_id = db.query(ChannelPost).filter_by(slug=NAVIGATION_SLUG).one().telegram_message_id
    sent_before = len(telegram.sent)

    price_channel.apply_plan(db, on_date=TODAY, slugs=["price_airpods"])
    price_channel.sync_navigation(db, on_date=TODAY)

    assert len(telegram.sent) == sent_before + 1        # только сам пост AirPods
    assert telegram.markup_edits[-1]["message_id"] == nav_id
    row = db.query(ChannelPost).filter_by(slug=NAVIGATION_SLUG).one()
    assert row.telegram_message_id == nav_id


def test_navigation_dry_run_sends_nothing(db, catalog, telegram):
    result = price_channel.sync_navigation(db, on_date=TODAY, dry_run=True)
    assert result.created == [NAVIGATION_SLUG]
    assert telegram.sent == []


# ---------------------------------------------------------------- API

@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_admin] = lambda: "admin:test"
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_api_plan_is_readonly(client, catalog, telegram):
    response = client.get("/api/admin/price-posts/plan")
    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["create"] == 2
    assert telegram.sent == []


def test_api_publish_requires_confirmation(client, catalog, telegram):
    response = client.post("/api/admin/price-posts/publish", json={"confirm": False})
    assert response.status_code == 400
    assert telegram.sent == []


def test_api_dry_run_allowed_without_confirmation(client, catalog, telegram):
    response = client.post("/api/admin/price-posts/publish",
                           json={"confirm": False, "dry_run": True})
    assert response.status_code == 200
    assert response.json()["dry_run"] is True
    assert telegram.sent == []


def test_api_publish_with_confirmation(client, catalog, telegram):
    response = client.post("/api/admin/price-posts/publish", json={"confirm": True})
    assert response.status_code == 200
    assert sorted(response.json()["created"]) == ["price_airpods", "price_iphone"]
    assert len(telegram.sent) == 2


def test_api_navigation_requires_confirmation(client, catalog, telegram):
    assert client.post("/api/admin/price-posts/navigation", json={}).status_code == 400
    assert telegram.sent == []


def test_api_generate_creates_drafts_only(client, catalog, telegram):
    response = client.post("/api/admin/price-posts/generate")
    assert response.status_code == 200
    assert response.json()["generated"] == 2
    assert telegram.sent == []


def test_api_list_shows_missing_sections(client, catalog, telegram):
    body = client.get("/api/admin/price-posts").json()
    assert body["posts"] == []
    missing = {s["slug"] for s in body["missing_sections"]}
    assert "price_iphone" in missing


def test_api_preview_single_section(client, catalog, telegram):
    body = client.get("/api/admin/price-posts/price_iphone/preview").json()
    assert "IPHONE — АКТУАЛЬНЫЙ ПРАЙС" in body["text"]
    assert body["over_limit"] is False
    assert client.get("/api/admin/price-posts/price_unknown/preview").status_code == 404


def test_navigation_keeps_sections_whose_slug_contains_underscore_p(db, telegram):
    """Регресс: фильтр частей длинного поста не должен есть обычные разделы.

    Части второй и далее называются price_<раздел>_p2. Первая версия фильтра
    искала подстроку «_p» и вычёркивала из навигации price_macbook_pro и
    price_playstation — в канале это выглядело как пропавшие кнопки.
    """
    db.add(Product(title="Apple MacBook Pro 14 M5", brand="Apple", category="ноутбуки",
                   subcategory="MacBook Pro", price=250000, is_active=True, sku="MBP-1"))
    db.add(Product(title="Sony DualSense", brand="Sony", category="консоли",
                   subcategory="Аксессуары PlayStation", price=6500, is_active=True, sku="PS-1"))
    db.commit()

    price_channel.apply_plan(db, on_date=TODAY)
    price_channel.sync_navigation(db, on_date=TODAY)

    labels = [row[0]["text"] for row in telegram.sent[-1]["keyboard"]]
    assert any("MacBook Pro" in label for label in labels)
    assert any("PlayStation" in label for label in labels)


def test_navigation_skips_continuation_parts(db, telegram):
    """А вот вторая часть длинного раздела в навигации не нужна."""
    from app.models.post import ChannelPost as CP

    db.add(CP(slug="price_iphone", kind=price_channel.PRICE_KIND,
              title="iPhone", body="x", telegram_message_id=1))
    db.add(CP(slug="price_iphone_p2", kind=price_channel.PRICE_KIND,
              title="iPhone (часть 2)", body="y", telegram_message_id=2))
    db.commit()

    price_channel.sync_navigation(db, on_date=TODAY)
    links = [b["url"] for row in telegram.sent[-1]["keyboard"] for b in row]
    assert any(link.endswith("/1") for link in links)
    assert not any(link.endswith("/2") for link in links)


def test_load_catalog_excludes_marketplace(db, catalog):
    """Прайс-пост уходит в ПУБЛИЧНЫЙ канал магазина. Чужой б/у товар в нём
    выглядит как собственный ассортимент — утечка не просто мимо изоляции, а
    вообще за пределы Mini App."""
    db.add(Product(title="iPhone 13 с рук", brand="Apple", category="смартфоны",
                   subcategory="iPhone", price=45000, is_active=True, sku="MP-1",
                   source=MARKETPLACE_SOURCE))
    db.commit()
    titles = [p["title"] for p in price_channel.load_catalog(db)]
    assert "Apple iPhone 17 256 Blue" in titles
    assert "iPhone 13 с рук" not in titles


def test_marketplace_item_never_reaches_channel_post(db, catalog, telegram):
    db.add(Product(title="iPhone 13 с рук", brand="Apple", category="смартфоны",
                   subcategory="iPhone", price=45000, is_active=True, sku="MP-2",
                   source=MARKETPLACE_SOURCE))
    db.commit()
    price_channel.apply_plan(db, on_date=TODAY)
    assert all("с рук" not in msg["text"] for msg in telegram.sent)
