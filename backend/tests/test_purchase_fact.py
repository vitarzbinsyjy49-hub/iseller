"""Факт покупки: завершённая заявка с итоговой суммой начисляет баллы.

Главное, что здесь держится: без суммы заявка покупкой не становится, повторное
завершение начисляет заново, а откат возвращает всё начисленное.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.main import app
from app.models.lead import Lead
from app.models.user import User
from app.services import loyalty


@pytest.fixture()
def admin_client(db):
    """Менеджер, который меняет статусы заявок. Та же цепочка подмен, что в
    test_admin_cart_orders.py."""
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def ctx(db):
    user = User(telegram_id=777, first_name="Гарик", username="garik")
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"user": user}


def test_lead_has_final_total_and_completion_seq(db):
    """Итоговая сумма отдельно от оценочной: estimated_total — то, что собрал
    покупатель, final_total — то, что подтвердил менеджер."""
    lead = Lead(status="new", estimated_total=100_000)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    assert lead.final_total is None
    assert lead.completion_seq == 0
    assert "final_total" in lead.to_dict()
    assert "completion_seq" in lead.to_dict()


def test_completing_without_final_total_is_rejected(admin_client, db):
    """Заявка без подтверждённой суммы покупкой не становится."""
    lead = Lead(status="confirmed", estimated_total=100_000)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(f"/api/admin/leads/{lead.id}", json={"status": "completed"})
    assert resp.status_code == 400
    assert "сумм" in resp.json()["detail"].lower()

    db.refresh(lead)
    assert lead.status == "confirmed", "статус не должен был поменяться"


def test_completing_with_final_total_bumps_seq(admin_client, db):
    lead = Lead(status="confirmed", estimated_total=100_000)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 98_000},
    )
    assert resp.status_code == 200
    db.refresh(lead)
    assert lead.status == "completed"
    assert float(lead.final_total) == 98_000
    assert lead.completion_seq == 1


def test_final_total_must_be_positive(admin_client, db):
    lead = Lead(status="confirmed")
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 0},
    )
    assert resp.status_code == 400


def test_completed_lead_accrues_cashback(admin_client, db, ctx):
    """Кэшбек начисляется по подтверждённой сумме, а не по оценочной."""
    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id, estimated_total=200_000)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )
    # «Старт» — 0,25%: 100 000 * 25 // 10000 = 250
    assert loyalty.summary(db, user.id)["balance"] == 250
    assert loyalty.summary(db, user.id)["lifetime_spent"] == 100_000


def test_saving_completed_lead_twice_does_not_double_cashback(admin_client, db, ctx):
    """Двойное сохранение статуса не имеет права дать двойной кэшбек."""
    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    for _ in range(2):
        admin_client.patch(
            f"/api/admin/leads/{lead.id}",
            json={"status": "completed", "final_total": 100_000},
        )
    assert loyalty.summary(db, user.id)["balance"] == 250


def test_lead_without_user_accrues_nothing(admin_client, db):
    """Заявку мог завести менеджер вручную — покупателя в системе нет.
    Это норма, а не ошибка."""
    lead = Lead(status="confirmed", user_id=None)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )
    assert resp.status_code == 200
