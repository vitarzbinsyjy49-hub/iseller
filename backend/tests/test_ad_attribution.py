"""Атрибуция рекламного трафика: ad_<кампания> -> users.acquisition_source.

Метка доезжает до нас двумя разными путями, и оба обязаны давать один и тот же
результат:

1. Прямая ссылка в Mini App (t.me/<bot>/<app>?startapp=ad_<кампания>): Telegram
   кладёт метку в initDataUnsafe.start_param, фронт отдаёт её в /auth/telegram.
2. Ссылка в ЧАТ с ботом (t.me/<bot>?start=ad_<кампания>) — так мы ведём платный
   трафик, потому что только чат даёт боту право писать человеку дальше. Здесь
   Telegram start_param в Mini App НЕ прокидывает, поэтому бот записывает
   первое касание в ad_touches, а _get_or_create_user читает его при создании
   пользователя (см. app/services/ad_touch.py).

Приоритет у start_param: он точнее — приходит в том же запросе, что и логин.

Главный инвариант: источник пишется РОВНО ОДИН РАЗ, при создании пользователя.
Иначе повторный органический вход по рекламной ссылке затрёт первый источник и
отчёт по каналам начнёт врать. Первое касание в ad_touches держит тот же
инвариант на шаг раньше — до того, как пользователь вообще появился.
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
    """Метка без товара — это по-прежнему каталог: ответ бота обязан совпадать
    с ответом на «catalog», иначе рекламный переход выглядит сломанным.
    (Атрибуция по этой ссылке идёт отдельно, через ad_touches — см. ниже.)"""
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


# ================================================= ?start= : первое касание
#
# Ссылка t.me/<bot>?start=ad_<кампания> ведёт в ЧАТ с ботом, а не в Mini App.
# Так и задумано: только чат даёт боту право писать человеку дальше (догон по
# корзине и избранному для пришедших по ?startapp= молчит навсегда). Плата за
# это — Telegram не прокидывает start_param в Mini App, открытый web_app-кнопкой
# из чата, поэтому источник доезжает не сам, а через ad_touches.

from app.models.ad_touch import AdTouch          # noqa: E402
from app.services import ad_touch as ad_touch_service   # noqa: E402


def _start_update(telegram_id: int, payload: str) -> dict:
    return {
        "message": {
            "chat": {"id": telegram_id, "type": "private"},
            "from": {"id": telegram_id},
            "text": f"/start {payload}",
        }
    }


def test_start_in_the_chat_records_the_first_touch(db):
    assert ad_touch_service.remember_from_update(db, _start_update(3001, "ad_direct")) == "direct"
    assert ad_touch_service.slug_for(db, 3001) == "direct"


def test_first_touch_is_never_overwritten(db):
    """Главный инвариант, тот же что и у acquisition_source: вторая ссылка не
    присваивает себе чужой приход. Здесь он обязан держаться на шаг раньше —
    ещё до того, как пользователь вообще появился в users."""
    assert ad_touch_service.remember_from_update(db, _start_update(3002, "ad_pervyi")) == "pervyi"
    assert ad_touch_service.remember_from_update(db, _start_update(3002, "ad_vtoroi")) is None
    assert ad_touch_service.slug_for(db, 3002) == "pervyi"
    assert db.query(AdTouch).filter(AdTouch.telegram_id == 3002).count() == 1


def test_a_repeated_start_does_not_raise(db):
    """Два /start подряд — обычное дело (человек нажал «Запустить» дважды).
    Ронять обработку апдейта из-за аналитики нельзя."""
    for _ in range(3):
        ad_touch_service.remember_from_update(db, _start_update(3003, "ad_direct"))
    assert db.query(AdTouch).filter(AdTouch.telegram_id == 3003).count() == 1


@pytest.mark.parametrize("payload", ["catalog", "product_42", "price_iphone", "ad_", "ad_моsкva"])
def test_non_ad_start_writes_no_touch(db, payload):
    assert ad_touch_service.remember_from_update(db, _start_update(3004, payload)) is None
    assert db.query(AdTouch).count() == 0


def test_touch_ignores_everything_but_a_private_start(db):
    """Пост канала, групповой чат, обычный текст — не касание рекламы."""
    channel = {"channel_post": {"chat": {"id": -100, "type": "channel"}, "text": "/start ad_x"}}
    group = _start_update(3005, "ad_x")
    group["message"]["chat"]["type"] = "group"
    plain = {"message": {"chat": {"id": 3005, "type": "private"}, "from": {"id": 3005}, "text": "ad_x"}}
    for update in (channel, group, plain, {}, {"message": None}):
        assert ad_touch_service.remember_from_update(db, update) is None
    assert db.query(AdTouch).count() == 0


def test_touch_survives_a_broken_update(db):
    """Атрибуция — не повод не ответить человеку: любая поломка внутри гасится."""
    broken = {"message": {"chat": {"type": "private"}, "text": 42}}
    assert ad_touch_service.remember_from_update(db, broken) is None


def test_login_after_a_chat_start_gets_the_source(db):
    """ГЛАВНЫЙ сценарий Директа: человек нажал «Запустить» в чате, потом открыл
    Mini App кнопкой из чата — start_param туда не приезжает, и до этого патча
    такой пользователь был неотличим от органики."""
    ad_touch_service.remember_from_update(db, _start_update(3100, "ad_direct"))
    user = _get_or_create_user(db, _tg_user(3100), _request(), start_param=None)
    assert user.acquisition_source == "ad_direct"
    events = _signup_events(db, user.id)
    assert len(events) == 1
    assert events[0].payload == {"source": "direct"}


def test_start_param_wins_over_the_chat_touch(db):
    """Приоритет у start_param: он точнее — приходит в том же запросе, что и
    логин, и не зависит от того, дожил ли чат с ботом до открытия приложения."""
    ad_touch_service.remember_from_update(db, _start_update(3101, "ad_iz-chata"))
    user = _get_or_create_user(db, _tg_user(3101), _request(), start_param="ad_iz-ssylki")
    assert user.acquisition_source == "ad_iz-ssylki"


def test_the_touch_does_not_resurrect_a_source_for_an_existing_user(db):
    """Касание попадает под то же ограничение `created`, что и start_param:
    органик, зарегистрировавшийся раньше, не получает источник задним числом."""
    user = _get_or_create_user(db, _tg_user(3102), _request())
    assert user.acquisition_source is None

    ad_touch_service.remember_from_update(db, _start_update(3102, "ad_pozdno"))
    again = _get_or_create_user(db, _tg_user(3102), _request())
    assert again.acquisition_source is None
    assert _signup_events(db, again.id) == []


def test_ad_signup_is_written_once_whichever_branch_supplied_the_source(db):
    """Событие ad_signup — про регистрацию, а не про визит: ровно одно на
    пользователя, из какой бы из двух веток ни пришёл источник."""
    ad_touch_service.remember_from_update(db, _start_update(3103, "ad_direct"))
    user = _get_or_create_user(db, _tg_user(3103), _request())
    _get_or_create_user(db, _tg_user(3103), _request(), start_param="ad_drugoi")
    assert len(_signup_events(db, user.id)) == 1
    assert user.acquisition_source == "ad_direct"


# ================================================= реклама на конкретный товар

@pytest.mark.parametrize("payload,slug,product_id", [
    ("ad_direct_product_42", "direct", 42),
    ("ad_direct", "direct", None),
    ("ad_kanal-2_product_7", "kanal-2", 7),
    # Хвост не похож на товар — вся строка снова метка, как было до патча.
    ("ad_direct_product_abc", "direct_product_abc", None),
    ("ad_direct_product_0", "direct_product_0", None),
    ("ad_direct_product_", "direct_product_", None),
    # «ad_product_42» — это кампания «product_42», а не товар без кампании:
    # разделителя «_product_» в строке нет.
    ("ad_product_42", "product_42", None),
    ("catalog", None, None),
    ("product_42", None, None),
    ("ad_", None, None),
])
def test_split_ad_payload(payload, slug, product_id):
    assert telegram_bot.split_ad_payload(payload) == (slug, product_id)


def test_campaign_label_ignores_the_product_tail():
    """Иначе каждое объявление стало бы отдельным источником, и точный `==`
    фильтр админки перестал бы агрегировать кампанию целиком."""
    assert telegram_bot.parse_ad_payload("ad_direct_product_42") == "direct"
    assert telegram_bot.parse_ad_payload("ad_direct") == "direct"
    assert telegram_bot.parse_ad_product_id("ad_direct_product_42") == 42
    assert telegram_bot.parse_ad_product_id("ad_direct") is None


def test_ad_with_a_product_resolves_to_the_card():
    """Обещание объявления и первый экран обязаны совпадать: «PS5 Slim за
    42 900» ведёт на карточку, а не на витрину, где её ещё надо найти."""
    assert telegram_bot.resolve_payload_path("ad_direct_product_42") == "/product/42"
    assert telegram_bot.resolve_payload_path("ad_direct") == "/catalog"


@pytest.fixture()
def mini_app(monkeypatch):
    """Настроенный Mini App: без него web_app-кнопок не бывает вовсе."""
    monkeypatch.setattr(telegram_bot.settings, "MINI_APP_URL", "https://shop.example.com", raising=False)


def test_ad_product_reply_matches_the_shared_product_reply(mini_app):
    """Симметрия ?start= и ?startapp=: с обеих ссылок человек обязан попасть на
    один экран, поэтому ответ бота переиспользует ветку обычного product_<id>."""
    ad = telegram_bot.reply_for_payload("ad_direct_product_42")
    shared = telegram_bot.reply_for_payload("product_42")
    assert ad is not None
    assert ad.text == shared.text
    assert ad.keyboard == shared.keyboard
    urls = [b["web_app"]["url"] for row in ad.keyboard for b in row if "web_app" in b]
    assert any(u.endswith("/product/42") for u in urls)


def test_a_missing_product_behaves_like_an_ordinary_deep_link(mini_app):
    """Несуществующий id не ходит в базу и не даёт 500 — ровно как сегодня у
    product_<несуществующий>: бот отдаёт кнопку, 404 показывает Mini App."""
    assert telegram_bot.resolve_payload_path("ad_direct_product_999999") == "/product/999999"
    assert telegram_bot.reply_for_payload("ad_direct_product_999999") is not None


def test_ad_product_payload_fits_telegram_limit():
    """Лимит Telegram на start-параметр — 64 символа, и максимальный рекламный
    payload обязан в него влезать ЦЕЛИКОМ, иначе ссылку просто обрежет."""
    longest = (
        telegram_bot.AD_PAYLOAD_PREFIX
        + "x" * telegram_bot.AD_SLUG_MAX
        + telegram_bot.AD_PRODUCT_SEPARATOR
        + "9" * 12          # тот же кап на id, что в parse_product_payload
    )
    assert len(longest) == 64
    assert telegram_bot.split_ad_payload(longest) == ("x" * telegram_bot.AD_SLUG_MAX, 999999999999)


def test_ad_touch_records_the_campaign_not_the_product(db):
    """Из «ad_direct_product_42» в источник уходит «ad_direct»: разбивка идёт
    по кампании, а не по объявлению."""
    ad_touch_service.remember_from_update(db, _start_update(3200, "ad_direct_product_42"))
    user = _get_or_create_user(db, _tg_user(3200), _request())
    assert user.acquisition_source == "ad_direct"


# ================================================= источник рекламы в заявках

def test_admin_leads_expose_the_acquisition_source(db):
    """Деньги приносят заявки, а разбивки по рекламному каналу у них не было.
    Lead.source трогать нельзя — это экран происхождения, общий справочник с
    витриной; источник приезжает из users."""
    from app.models.lead import Lead

    paid = User(telegram_id=4001, first_name="Аня", acquisition_source="ad_direct")
    organic = User(telegram_id=4002, first_name="Боря")
    db.add_all([paid, organic])
    db.commit()
    db.add_all([
        Lead(user_id=paid.id, name="Аня", phone="+70000000001", source="product", status="new"),
        Lead(user_id=organic.id, name="Боря", phone="+70000000002", source="ai", status="new"),
        Lead(name="Гость", phone="+70000000003", source="catalog", status="new"),
    ])
    db.commit()

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        rows = TestClient(app).get("/api/admin/leads").json()["leads"]
    finally:
        app.dependency_overrides.clear()

    by_name = {r["name"]: r for r in rows}
    assert by_name["Аня"]["acquisition_source"] == "ad_direct"
    assert by_name["Боря"]["acquisition_source"] is None
    assert by_name["Гость"]["acquisition_source"] is None
    # Экран происхождения остался нетронутым — это разные оси.
    assert by_name["Аня"]["source"] == "product"
