"""Отзывы: привязка к покупке, модерация, средняя оценка.

Главное свойство, которое здесь защищается: отзыв не существует без
завершённой заявки. На витрине он идёт с бейджем «покупка подтверждена», и
этот бейдж честен ровно потому, что иначе строка сюда не попадает. Любая
дыра в проверке превращает его в украшение.
"""
import pytest

from app.models.lead import Lead
from app.models.review import Review
from app.services import reviews
from tests.conftest import make_product


def make_lead(db, *, status="completed", **kw) -> Lead:
    defaults = dict(
        name="Дмитрий", telegram_id=555, user_id=1, status=status,
        product_id=None, product_title="iPhone 17 Pro", items_count=1,
        final_total=100000, completion_seq=1,
    )
    defaults.update(kw)
    lead = Lead(**defaults)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


# ---------------------------------------------------------------- приём

def test_review_requires_completed_lead(db):
    """Незавершённая заявка — не покупка. Отзыв по ней ничего не подтверждает."""
    lead = make_lead(db, status="in_progress")
    with pytest.raises(reviews.ReviewError):
        reviews.submit(db, lead=lead, rating=5, text="отлично")


@pytest.mark.parametrize("rating", [0, 6, -1, 2.5, "5", None])
def test_rating_outside_scale_is_rejected(db, rating):
    """Оценка приходит из Mini App, то есть снаружи: проверяем границы, а не
    доверяем форме."""
    lead = make_lead(db)
    with pytest.raises(reviews.ReviewError):
        reviews.submit(db, lead=lead, rating=rating)


def test_submitted_review_waits_for_moderation(db):
    lead = make_lead(db)
    row = reviews.submit(db, lead=lead, rating=5, text="Всё совпало с приложением")
    db.commit()
    assert row.status == "pending"
    assert row.published_at is None
    # На витрине его пока нет.
    assert reviews.approved(db) == []


def test_second_submit_edits_the_same_review(db):
    """Одна заявка — один отзыв. Человек имеет право передумать до модерации."""
    lead = make_lead(db)
    reviews.submit(db, lead=lead, rating=3, text="нормально")
    db.commit()
    reviews.submit(db, lead=lead, rating=5, text="перечитал, всё отлично")
    db.commit()
    rows = db.query(Review).filter(Review.lead_id == lead.id).all()
    assert len(rows) == 1
    assert rows[0].rating == 5


def test_published_review_cannot_be_silently_rewritten(db):
    """Подменить текст под уже опубликованным «подтверждено» — это подмена
    витрины, а не правка опечатки."""
    lead = make_lead(db)
    row = reviews.submit(db, lead=lead, rating=5, text="хорошо")
    db.commit()
    reviews.moderate(db, row, status="approved")
    db.commit()
    with pytest.raises(reviews.ReviewError):
        reviews.submit(db, lead=lead, rating=1, text="на самом деле плохо")


# ---------------------------------------------------------------- товар

def test_single_item_lead_attaches_review_to_its_product(db):
    product = make_product(db)
    lead = make_lead(db, product_id=product.id)
    row = reviews.submit(db, lead=lead, rating=5)
    db.commit()
    assert row.product_id == product.id


def test_cart_lead_without_obvious_product_stays_in_the_general_feed(db):
    """Приписать отзыв случайной позиции из пяти значит соврать на карточке."""
    lead = make_lead(db, product_id=None, items_count=3)
    row = reviews.submit(db, lead=lead, rating=5)
    db.commit()
    assert row.product_id is None


# ---------------------------------------------------------------- модерация

def test_approved_review_reaches_the_storefront(db):
    product = make_product(db)
    lead = make_lead(db, product_id=product.id)
    row = reviews.submit(db, lead=lead, rating=5, text="Проверили при мне")
    db.commit()
    reviews.moderate(db, row, status="approved")
    db.commit()

    assert row.published_at is not None
    assert [r.id for r in reviews.approved_for_product(db, product.id)] == [row.id]
    assert reviews.summary_for_product(db, product.id) == {"rating": 5.0, "count": 1}


def test_rejected_review_is_kept_but_hidden(db):
    """Удалить — значит забыть, что мы уже решали по этому отзыву."""
    product = make_product(db)
    lead = make_lead(db, product_id=product.id)
    row = reviews.submit(db, lead=lead, rating=1, text="спам")
    db.commit()
    reviews.moderate(db, row, status="rejected", note="реклама")

    db.commit()
    assert db.get(Review, row.id) is not None
    assert reviews.approved_for_product(db, product.id) == []
    assert row.moderator_note == "реклама"


def test_product_rating_counts_only_approved(db):
    """Иначе оценку товара двигал бы любой, кто открыл форму."""
    product = make_product(db, rating=0)
    approved_lead = make_lead(db, product_id=product.id)
    pending_lead = make_lead(db, product_id=product.id, user_id=2)

    good = reviews.submit(db, lead=approved_lead, rating=5)
    db.commit()
    reviews.moderate(db, good, status="approved")
    db.commit()

    reviews.submit(db, lead=pending_lead, rating=1)   # ждёт модерации
    db.commit()
    reviews.recompute_product_rating(db, product.id)
    db.commit()

    assert product.rating == 5.0
    assert reviews.summary_for_product(db, product.id)["count"] == 1


def test_summary_for_product_without_reviews_is_zero_not_none(db):
    """Витрине проще не рисовать блок по count == 0, чем разбирать пустоту."""
    product = make_product(db)
    assert reviews.summary_for_product(db, product.id) == {"rating": 0.0, "count": 0}


# ---------------------------------------------------------------- просьба

def test_request_is_queued_once_per_completion(db, monkeypatch):
    """Повторная просьба читается покупателем как невнимательность магазина."""
    monkeypatch.setattr(reviews, "notifications_enabled", lambda: True)
    monkeypatch.setattr(reviews.settings, "MINI_APP_URL", "https://app.example.com",
                        raising=False)
    lead = make_lead(db)

    reviews.request_for_lead(db, lead)
    db.commit()
    reviews.request_for_lead(db, lead)
    db.commit()

    from app.models.notification import Notification
    rows = db.query(Notification).filter(Notification.kind == reviews.NOTIFY_KIND).all()
    assert len(rows) == 1
    assert "Оценить заказ" in str(rows[0].keyboard)


def test_no_request_when_the_buyer_already_wrote(db, monkeypatch):
    monkeypatch.setattr(reviews, "notifications_enabled", lambda: True)
    lead = make_lead(db)
    reviews.submit(db, lead=lead, rating=5)
    db.commit()

    reviews.request_for_lead(db, lead)
    db.commit()

    from app.models.notification import Notification
    assert db.query(Notification).count() == 0


def test_request_without_mini_app_url_still_sends_text(db, monkeypatch):
    """web_app-кнопку без валидного https Telegram отвергает вместе со ВСЕМ
    сообщением — лучше просьба без кнопки, чем недоставленная просьба."""
    monkeypatch.setattr(reviews, "notifications_enabled", lambda: True)
    monkeypatch.setattr(reviews.settings, "MINI_APP_URL", "", raising=False)
    message = reviews.request_message(make_lead(db))
    assert message is not None and message.keyboard == []
    assert "Оцените заказ" in message.text


# ---------------------------------------------------------------- смена товара

def test_review_follows_the_product_that_was_actually_bought(db):
    """Человек пришёл за наушниками с шумоподавлением, а взял обычные.

    Снапшот заявки при этом не переписывается: расхождение «сравнил не то» —
    это сведения о витрине, а не мусор. Отзыв же обязан висеть на том, что
    человек реально унёс.
    """
    wanted = make_product(db, title="AirPods Pro 3 с шумоподавлением")
    bought = make_product(db, title="AirPods 4")
    lead = make_lead(db, product_id=wanted.id)
    lead.purchased_product_id = bought.id
    db.commit()

    row = reviews.submit(db, lead=lead, rating=5, text="Взял обычные, доволен")
    db.commit()

    assert row.product_id == bought.id
    assert lead.product_id == wanted.id     # снапшот цел


def test_snapshot_product_is_used_when_nothing_was_overridden(db):
    product = make_product(db)
    lead = make_lead(db, product_id=product.id)
    assert lead.purchased_product_id is None
    row = reviews.submit(db, lead=lead, rating=4)
    db.commit()
    assert row.product_id == product.id
