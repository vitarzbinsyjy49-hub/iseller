"""Атрибуция рекламного трафика: ad_<канал> -> users.acquisition_source.

Метка долетает до нас ТОЛЬКО через прямую ссылку в Mini App
(t.me/<bot>/<app>?startapp=ad_<канал>): Telegram кладёт её в
initDataUnsafe.start_param, фронт отдаёт её в /auth/telegram. Через обычный
чат-диплинк (?start=) start_param в Mini App не прокидывается — это
ограничение платформы, поэтому по такой ссылке источник не пишется, и человек
просто попадает в каталог.

Главный инвариант: источник пишется РОВНО ОДИН РАЗ, при создании пользователя.
Иначе повторный органический вход по рекламной ссылке затрёт первый источник и
отчёт по каналам начнёт врать.
"""
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.api.auth import _get_or_create_user
from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.analytics_event import AnalyticsEvent
from app.models.user import User
from app.services import telegram_bot


# ------------------------------------------------- parse_ad_payload

@pytest.mark.parametrize("payload,expected", [
    ("ad_moskvatoday", "moskvatoday"),
    ("ad_glavnoe", "glavnoe"),
    ("ad_kanal-2", "kanal-2"),
    ("ad_kanal_2", "kanal_2"),
    ("ad_" + "x" * 40, "x" * 40),   # ровно на границе длины
])
def test_parse_ad_payload_accepts_real_campaign_labels(payload, expected):
    assert telegram_bot.parse_ad_payload(payload) == expected


@pytest.mark.parametrize("payload", [
    "ad_",                  # префикс без метки — не источник
    "ad_" + "x" * 41,       # длиннее лимита: колонка VARCHAR(64) и URL кнопки
    "ad_моsкva",            # кириллица: isalnum() её пропускает, Telegram — нет
    "ad_٤٢",                # арабские цифры — та же ловушка
    "ad_kanal 2",           # пробел
    "ad_kanal/../admin",    # попытка вылезти из маршрута
    "ad_kanal.2",           # точка не входит в allowlist
    "catalog",              # статический payload — не реклама
    "product_42",           # диплинк на товар — не реклама
    "price_iphone",         # раздел прайса — не реклама
    "advert",               # похоже на префикс, но это не "ad_"
    "совсем не существует",
    "",
])
def test_parse_ad_payload_rejects_everything_else(payload):
    """Метку собираем мы сами вручную под каждое размещение, но приходит она из
    открытой ссылки и попадает и в URL, и в БД как есть — allowlist строгий."""
    assert telegram_bot.parse_ad_payload(payload) is None


# ------------------------------------------------- навигация по рекламной метке

def test_ad_payload_resolves_to_the_catalog():
    """Рекламная метка сама по себе не экран: человек с неё должен попасть в
    каталог, а не в пустоту. Раньше «ad_что-угодно» был незнакомым payload'ом."""
    assert telegram_bot.resolve_payload_path("ad_moskvatoday") == "/catalog"
    assert telegram_bot.resolve_payload_path("ad_x") == "/catalog"


def test_broken_ad_payload_stays_unknown():
    """Отбракованная метка не должна тихо превращаться в каталог — иначе
    опечатка в ссылке выглядела бы рабочей и мы бы её не заметили."""
    assert telegram_bot.resolve_payload_path("ad_") is None
    assert telegram_bot.resolve_payload_path("ad_kanal.2") is None


def test_ad_payload_reply_is_the_same_as_for_catalog():
    """Через чат-диплинк (?start=ad_x) атрибуция не пишется — Telegram не даёт
    start_param в web_app-кнопку из чата, — но ответ бота обязан совпадать с
    ответом на «catalog», иначе рекламный переход выглядит сломанным."""
    ad = telegram_bot.reply_for_payload("ad_moskvatoday")
    catalog = telegram_bot.reply_for_payload("catalog")
    assert ad is not None
    assert ad.text == catalog.text
    assert ad.keyboard == catalog.keyboard


# ------------------------------------------------- запись источника при создании

def _request() -> Request:
    return Request({
        "type": "http", "method": "POST", "path": "/api/auth/telegram",
        "headers": [], "client": ("127.0.0.1", 1234),
    })


def _tg_user(tid: int) -> dict:
    return {"id": tid, "username": "olya", "first_name": "Оля", "last_name": None}


def _signup_events(db, user_id: int) -> list[AnalyticsEvent]:
    return [
        e for e in db.query(AnalyticsEvent).all()
        if e.event == "ad_signup" and e.user_id == user_id
    ]


def test_new_user_from_an_ad_link_gets_the_source(db):
    user = _get_or_create_user(db, _tg_user(1001), _request(), start_param="ad_moskvatoday")
    assert user.acquisition_source == "ad_moskvatoday"

    events = _signup_events(db, user.id)
    assert len(events) == 1
    assert events[0].payload == {"source": "moskvatoday"}


def test_existing_user_keeps_the_first_source(db):
    """Ключевой инвариант: второй заход по ДРУГОЙ рекламной ссылке не должен
    переписать источник — иначе последняя ссылка присвоила бы себе чужой
    приход, и разбивка по каналам поехала бы в первый же день."""
    first = _get_or_create_user(db, _tg_user(1002), _request(), start_param="ad_pervyi")
    assert first.acquisition_source == "ad_pervyi"

    again = _get_or_create_user(db, _tg_user(1002), _request(), start_param="ad_vtoroi")
    assert again.id == first.id
    assert again.acquisition_source == "ad_pervyi"
    # И событие остаётся одно: это регистрация, а не визит.
    assert len(_signup_events(db, first.id)) == 1


def test_organic_return_does_not_erase_the_source(db):
    user = _get_or_create_user(db, _tg_user(1003), _request(), start_param="ad_glavnoe")
    again = _get_or_create_user(db, _tg_user(1003), _request(), start_param=None)
    assert again.acquisition_source == "ad_glavnoe"
    assert len(_signup_events(db, user.id)) == 1


@pytest.mark.parametrize("start_param", [None, "", "product_42", "catalog", "ad_", "ad_моsкva"])
def test_non_ad_start_param_writes_nothing(db, start_param):
    """Шеринг товара и обычные диплинки — не рекламный канал: у такого
    пользователя источник обязан остаться пустым, а не «ad_product_42»."""
    user = _get_or_create_user(db, _tg_user(1100), _request(), start_param=start_param)
    assert user.acquisition_source is None
    assert _signup_events(db, user.id) == []


def test_source_is_absent_by_default(db):
    """Совсем без start_param (dev-вход, старый клиент) — тоже пусто."""
    user = _get_or_create_user(db, _tg_user(1200), _request())
    assert user.acquisition_source is None


# ------------------------------------------------- фильтр в админке

@pytest.fixture()
def admin(db):
    db.add_all([
        User(telegram_id=2001, first_name="Аня", acquisition_source="ad_glavnoe"),
        User(telegram_id=2002, first_name="Боря", acquisition_source="ad_moskvatoday"),
        User(telegram_id=2003, first_name="Вера"),   # органика
    ])
    db.commit()

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    app.dependency_overrides[get_current_user] = lambda: db.query(User).first()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_admin_list_exposes_the_source(admin):
    rows = admin.get("/api/admin/users").json()["users"]
    by_tg = {r["telegram_id"]: r["acquisition_source"] for r in rows}
    assert by_tg[2001] == "ad_glavnoe"
    assert by_tg[2003] is None


def test_admin_list_filters_by_source(admin):
    """Совпадение точное: source — код кампании, а не строка для нечёткого
    поиска. «ad_glavnoe» не должен подтягивать соседние кампании."""
    rows = admin.get("/api/admin/users?source=ad_glavnoe").json()["users"]
    assert [r["telegram_id"] for r in rows] == [2001]

    assert admin.get("/api/admin/users?source=ad_net-takogo").json()["users"] == []
