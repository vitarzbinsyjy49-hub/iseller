"""Социальное доказательство на карточке (патч 1.1, фича #6).

Главное требование — НЕ соврать. Всё, что здесь показывается, обязано быть
посчитано по реальным записям, а не по клиентским событиям и уж тем более не
придумано. Поэтому тесты в основном про то, чего показывать НЕЛЬЗЯ.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.favorite import ProductFavorite
from app.models.lead import Lead
from app.models.lead_item import LeadItem
from app.models.user import User
from app.services.social_proof import (
    apply_social_proof,
    favorite_counts,
    order_counts,
    social_proof_label,
)
from tests.conftest import make_product

# Отсчёт от РЕАЛЬНОГО «сейчас», а не от зашитой даты. Фиксированная дата тут
# была миной с часовым механизмом: заявки в тестах ставятся как NOW - days_ago,
# а `apply_social_proof` в API-тестах считает окно от настоящего времени — и
# ровно через SOCIAL_PROOF_ORDER_WINDOW_DAYS дней после зашитого числа свежая
# заявка (days_ago=0) уезжала за окно, роняя test_product_detail_exposes_social_proof
# на ровном месте. Детерминизм от этого не страдает: юнит-тесты чистой функции
# передают этот же NOW в order_counts(now=...) явно, а внутри одного прогона он
# один и тот же.
NOW = datetime.now(timezone.utc)


def naive(dt: datetime) -> datetime:
    """sqlite в тестах хранит время без tz — сравнение должно быть однородным."""
    return dt.replace(tzinfo=None)


def make_user(db, telegram_id: int) -> User:
    user = User(telegram_id=telegram_id, first_name=f"U{telegram_id}")
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def make_lead(db, *, product=None, status="new", days_ago=1, items=()) -> Lead:
    lead = Lead(
        telegram_id=1, name="Гарик", status=status, source="product",
        product_id=product.id if product is not None else None,
        product_title=product.title if product is not None else None,
    )
    db.add(lead)
    db.flush()
    lead.created_at = naive(NOW - timedelta(days=days_ago))
    for item_product, qty in items:
        db.add(LeadItem(
            lead_id=lead.id, product_id=item_product.id,
            title_snapshot=item_product.title, price_snapshot=item_product.price,
            quantity=qty, line_total=float(item_product.price) * qty,
        ))
    db.commit()
    db.refresh(lead)
    return lead


def counts(db, product):
    return order_counts(db, [product.id], now=NOW)


# ======================= Тексты (чистая функция) =======================
def test_nothing_to_say_is_no_badge():
    """Ноль — это отсутствие бейджа, а не «0 заказов»."""
    assert social_proof_label(orders=0, favorites=0) is None


def test_below_threshold_stays_silent():
    """«Заказывали 1 раз» отталкивает сильнее, чем молчание."""
    assert social_proof_label(orders=1) is None
    assert social_proof_label(orders=2) is None
    assert social_proof_label(favorites=1) is None
    assert social_proof_label(favorites=4) is None


def test_orders_win_over_favorites():
    """Состоявшееся намерение купить важнее закладки — и бейдж ровно один.

    Два-три бейджа подряд читаются как реклама и обесценивают друг друга.
    """
    label = social_proof_label(orders=5, favorites=50)
    assert label == "Заказывали 5 раз за месяц"


def test_favorites_shown_when_no_orders():
    assert social_proof_label(orders=0, favorites=7) == "В избранном у 7 человек"


@pytest.mark.parametrize("n,expected", [
    (3, "Заказывали 3 раза за месяц"),
    (5, "Заказывали 5 раз за месяц"),
    (11, "Заказывали 11 раз за месяц"),
    (21, "Заказывали 21 раз за месяц"),
    (22, "Заказывали 22 раза за месяц"),
])
def test_order_plurals(n, expected):
    assert social_proof_label(orders=n) == expected


@pytest.mark.parametrize("n,expected", [
    (5, "В избранном у 5 человек"),
    (21, "В избранном у 21 человека"),
    (22, "В избранном у 22 человек"),
    (105, "В избранном у 105 человек"),
])
def test_favorite_plurals(n, expected):
    assert social_proof_label(favorites=n) == expected


def test_labels_fit_the_catalog_tile():
    """Строка обязана помещаться в плитку каталога без многоточия.

    Замер в браузере на 390px: доступно 149px при шрифте 11px, и вариант
    «N человек добавили в избранное» занимал 169–180px. Обрезанное социальное
    доказательство не убеждает, а держать отдельный короткий текст для плитки
    значит завести вторую версию того же утверждения.
    """
    longest = max(
        (social_proof_label(orders=n) for n in (3, 22, 105)),
        key=len,
    )
    assert len(longest) <= 30, longest
    longest_fav = max(
        (social_proof_label(favorites=n) for n in (5, 22, 105)),
        key=len,
    )
    assert len(longest_fav) <= 30, longest_fav


def test_disabled_switch_silences_everything(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.SOCIAL_PROOF_ENABLED", False)
    assert social_proof_label(orders=100, favorites=100) is None


def test_label_invents_no_urgency():
    """Ни срочности, ни остатков, ни «смотрят прямо сейчас» — их никто не считал."""
    for label in (social_proof_label(orders=9), social_proof_label(favorites=9)):
        lowered = label.lower()
        for invented in ("осталось", "сейчас", "успей", "заканчива", "хит", "популярн"):
            assert invented not in lowered, f"выдуманное утверждение: {invented}"


# ======================= Подсчёт заказов =======================
def test_single_product_leads_are_counted(db):
    """Одиночная заявка живёт в leads.product_id, а НЕ в lead_items.

    Считать только позиции корзины — тихо потерять почти весь реальный спрос:
    на проде на момент написания было 3 заявки и 0 позиций корзины.
    """
    product = make_product(db, sku="A")
    for _ in range(3):
        make_lead(db, product=product)

    assert counts(db, product) == {product.id: 3}


def test_cart_leads_are_counted(db):
    product = make_product(db, sku="A")
    for _ in range(2):
        make_lead(db, items=[(product, 1)])

    assert counts(db, product) == {product.id: 2}


def test_quantity_does_not_inflate_the_count(db):
    """Пять штук в одной корзине одного человека — это ОДИН заказ.

    Иначе «заказывали 5 раз» описывало бы одного покупателя.
    """
    product = make_product(db, sku="A")
    make_lead(db, items=[(product, 5)])

    assert counts(db, product) == {product.id: 1}


def test_cancelled_leads_are_excluded(db):
    """«Заказывали 8 раз», где половина отменена, — уже преувеличение."""
    product = make_product(db, sku="A")
    make_lead(db, product=product, status="new")
    make_lead(db, product=product, status="cancelled")
    make_lead(db, product=product, status="cancelled")

    assert counts(db, product) == {product.id: 1}


def test_old_leads_fall_out_of_the_window(db):
    """Год назад продавалось хорошо — не аргумент сегодня."""
    product = make_product(db, sku="A")
    make_lead(db, product=product, days_ago=2)
    make_lead(db, product=product, days_ago=400)

    assert counts(db, product) == {product.id: 1}


def test_same_lead_counted_once_across_both_sources(db):
    """Товар в leads.product_id И в позициях той же заявки — это один заказ."""
    product = make_product(db, sku="A")
    make_lead(db, product=product, items=[(product, 1)])

    assert counts(db, product) == {product.id: 1}


def test_counts_are_per_product(db):
    a = make_product(db, sku="A")
    b = make_product(db, sku="B")
    make_lead(db, product=a)
    make_lead(db, product=a)
    make_lead(db, product=b)

    assert order_counts(db, [a.id, b.id], now=NOW) == {a.id: 2, b.id: 1}


def test_empty_id_list_makes_no_query(db):
    assert order_counts(db, [], now=NOW) == {}
    assert favorite_counts(db, []) == {}


# ======================= Подсчёт избранного =======================
def test_favorites_count_distinct_people(db):
    product = make_product(db, sku="A")
    for tg in (1, 2, 3):
        user = make_user(db, tg)
        db.add(ProductFavorite(user_id=user.id, product_id=product.id))
    db.commit()

    assert favorite_counts(db, [product.id]) == {product.id: 3}


# ======================= Сборка ответа =======================
def test_apply_social_proof_sets_the_key_even_when_empty(db):
    """Ключ есть всегда: иначе фронт не отличит «не посчитали» от «нечего сказать»."""
    product = make_product(db, sku="A")
    payload = {}
    apply_social_proof(db, [product], [payload])
    assert payload["social_proof"] is None


def test_apply_social_proof_is_batched(db):
    """Два запроса на весь ответ, а не по паре на карточку.

    Это не микрооптимизация: карточек в выдаче до сотни, и подсчёт «по товару»
    превратил бы каталог в двести запросов.
    """
    products = [make_product(db, sku=f"S{i}") for i in range(5)]
    payloads = [{} for _ in products]
    # Прогреваем объекты ДО замера: после commit они «протухают», и первое же
    # обращение к p.id тянет по запросу на товар. В реальном эндпоинте товары
    # приходят из свежей выборки, поэтому это артефакт теста, а не кода — но
    # без прогрева он маскировал бы настоящее число запросов.
    _ = [p.id for p in products]

    from sqlalchemy import event

    queries: list[str] = []
    engine = db.get_bind()

    def before(conn, cursor, statement, params, context, executemany):
        queries.append(statement)

    event.listen(engine, "before_cursor_execute", before)
    try:
        apply_social_proof(db, products, payloads)
    finally:
        event.remove(engine, "before_cursor_execute", before)

    assert len(queries) == 2, f"ожидалось 2 запроса, было {len(queries)}"


# ======================= HTTP =======================
@pytest.fixture()
def client(db):
    user = User(telegram_id=777, first_name="Гарик")
    db.add(user)
    db.commit()
    db.refresh(user)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    try:
        yield TestClient(app), db
    finally:
        app.dependency_overrides.clear()


def test_product_detail_exposes_social_proof(client):
    api, db = client
    product = make_product(db, sku="A")
    for _ in range(4):
        make_lead(db, product=product, days_ago=0)

    data = api.get(f"/api/catalog/product/{product.id}").json()
    assert data["social_proof"] == "Заказывали 4 раза за месяц"


def test_catalog_list_exposes_social_proof(client):
    api, db = client
    product = make_product(db, sku="A")
    data = api.get("/api/catalog/list").json()
    assert all("social_proof" in c for c in data["cards"])


def test_client_events_cannot_inflate_social_proof(client):
    """Накрутка через /api/events/product не должна влиять на бейдж.

    Этот эндпоинт принимает event_type из общего allowlist, включая
    favorite_add и lead_created. Для персональных рекомендаций это безопасно —
    человек портит только свою выдачу. Но число, которое видят ВСЕ, обязано
    считаться по таблицам фактов, иначе любой клиент нарисует любому товару
    любую популярность.
    """
    api, db = client
    product = make_product(db, sku="A")

    for _ in range(30):
        api.post("/api/events/product",
                 json={"event_type": "lead_created", "product_id": product.id})
        api.post("/api/events/product",
                 json={"event_type": "favorite_add", "product_id": product.id})

    data = api.get(f"/api/catalog/product/{product.id}").json()
    assert data["social_proof"] is None
