"""«Сообщить об ошибке» из профиля: приём, алерт владельцу, закрытие.

Сообщение об ошибке — НЕ заявка. Заявка тянет за собой продажную механику:
закрытие требует сумму сделки и начисляет баллы, покупателю уходят тексты
про «состав и цену», счётчики заявок в аналитике считают конверсию. Баг в
этой механике был бы шумом, поэтому у него своя таблица.
"""
import pytest

from app.models.bug_report import BugReport
from app.models.notification import Notification
from app.models.user import User
from app.services import bug_reports, notifications


@pytest.fixture()
def user(db) -> User:
    row = User(telegram_id=7678374811, username="buyer", first_name="Дима")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def alerts_on(monkeypatch):
    monkeypatch.setattr(notifications, "notifications_enabled", lambda: True)
    monkeypatch.setattr(notifications, "admin_chat_id", lambda: 42)


def test_report_is_saved_with_author_and_screenshots(db, user):
    row = bug_reports.submit(
        db, user=user, text="  Кнопка «В корзину» не нажимается  ",
        photos=["/api/uploads/a.jpg", "/api/uploads/b.png"],
        context={"platform": "ios", "path": "/product/12"},
    )
    db.commit()

    saved = db.query(BugReport).one()
    assert saved.id == row.id
    assert saved.text == "Кнопка «В корзину» не нажимается"
    assert saved.photos == ["/api/uploads/a.jpg", "/api/uploads/b.png"]
    assert saved.user_id == user.id and saved.telegram_id == 7678374811
    assert saved.username == "buyer"
    assert saved.status == "new"
    assert saved.context == {"platform": "ios", "path": "/product/12"}


@pytest.mark.parametrize("text", ["", "   ", "ой", None])
def test_empty_or_too_short_text_is_rejected(db, user, text):
    """Скриншот без слов не объясняет, что пошло не так."""
    with pytest.raises(bug_reports.BugReportError):
        bug_reports.submit(db, user=user, text=text)


def test_foreign_links_and_extra_screenshots_are_dropped(db, user):
    """Фото рисуются в админке ссылками, поэтому чужой адрес туда не доезжает."""
    photos = ["https://evil.example/x.jpg", "javascript:alert(1)"] + [
        f"/api/uploads/{i}.jpg" for i in range(10)
    ]
    row = bug_reports.submit(db, user=user, text="Не открывается каталог", photos=photos)
    assert row.photos == [f"/api/uploads/{i}.jpg" for i in range(bug_reports.MAX_PHOTOS)]


def test_context_keeps_only_known_short_fields(db, user):
    """Контекст собирает клиент, то есть он приходит снаружи."""
    row = bug_reports.submit(
        db, user=user, text="Белый экран после оплаты",
        context={"platform": "android", "tg_version": "8.0", "viewport": "390x844",
                 "user_agent": "x" * 2000, "secret": "nope", "path": 123},
    )
    assert set(row.context) == {"platform", "tg_version", "viewport", "user_agent"}
    assert len(row.context["user_agent"]) == bug_reports.CONTEXT_MAX_LEN


def test_owner_gets_alert_in_same_transaction(db, user, alerts_on):
    row = bug_reports.submit(db, user=user, text="Цена в корзине не совпадает с карточкой",
                             photos=["/api/uploads/a.jpg"], context={"platform": "ios"})
    db.commit()

    note = db.query(Notification).one()
    assert note.chat_id == 42 and note.kind == "bug_report"
    assert f"#{row.id}" in note.text
    assert "Цена в корзине не совпадает" in note.text
    assert "@buyer" in note.text
    assert "Скриншотов: 1" in note.text
    assert "ios" in note.text


def test_alert_escapes_html(db, user, alerts_on):
    """Текст пишет покупатель, а уведомление уходит с parse_mode=HTML."""
    bug_reports.submit(db, user=user, text="<b>жирный</b> & сломанный")
    db.commit()
    note = db.query(Notification).one()
    assert "<b>жирный</b>" not in note.text
    assert "&lt;b&gt;жирный&lt;/b&gt; &amp; сломанный" in note.text


def test_no_alert_without_bot(db, user):
    bug_reports.submit(db, user=user, text="Не грузятся фото")
    db.commit()
    assert db.query(Notification).count() == 0


def test_fixed_report_thanks_the_author_once(db, user, alerts_on):
    """Человек потратил время — ему стоит узнать, что это не ушло в пустоту."""
    row = bug_reports.submit(db, user=user, text="Не работает поиск по бренду")
    db.commit()

    bug_reports.set_status(db, row, "fixed")
    bug_reports.set_status(db, row, "new")
    bug_reports.set_status(db, row, "fixed")
    db.commit()

    thanks = db.query(Notification).filter_by(chat_id=user.telegram_id).all()
    assert len(thanks) == 1
    assert "исправили" in thanks[0].text.lower()
    assert row.status == "fixed" and row.resolved_at is not None


def test_declined_report_is_closed_silently(db, user, alerts_on):
    row = bug_reports.submit(db, user=user, text="Хочу тёмную тему")
    db.commit()
    bug_reports.set_status(db, row, "declined", note="это пожелание, не ошибка")
    db.commit()
    assert row.status == "declined" and row.manager_note == "это пожелание, не ошибка"
    assert db.query(Notification).filter_by(chat_id=user.telegram_id).count() == 0


def test_unknown_status_is_rejected(db, user):
    row = bug_reports.submit(db, user=user, text="Не открывается профиль")
    with pytest.raises(bug_reports.BugReportError):
        bug_reports.set_status(db, row, "done")
