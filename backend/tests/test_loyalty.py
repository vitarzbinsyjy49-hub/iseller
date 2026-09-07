"""Лояльность: журнал как источник правды, уровни, ставки, права.

Главное, что здесь держится, — инварианты, которые легко сломать обратно:
баланс не уходит в минус, списание не роняет уровень, повтор операции не даёт
двойной кэшбек, а чужой счёт не виден никому.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.loyalty import LoyaltyTransaction
from app.models.user import User
from app.services import loyalty


@pytest.fixture()
def ctx(db):
    user = User(telegram_id=777, first_name="Гарик", username="garik")
    other = User(telegram_id=778, first_name="Сосед", username="neighbour")
    db.add_all([user, other])
    db.commit()
    db.refresh(user)
    db.refresh(other)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, user.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, user, other
    finally:
        app.dependency_overrides.clear()


# ---------------------------------------------------------------- чистые правила


@pytest.mark.parametrize("spent,key", [
    (0, "start"),
    (149_999, "start"),        # граница: рубля не хватило — уровень прежний
    (150_000, "silver"),
    (399_999, "silver"),
    (400_000, "gold"),
    (800_000, "platinum"),
    (1_500_000, "black"),
    (9_000_000, "black"),      # выше вершины уровня нет
])
def test_level_boundaries(spent, key):
    assert loyalty.level_for(spent).key == key


def test_points_rounded_down():
    """Округление вверх дарило бы по баллу на каждой операции."""
    assert loyalty.points_for(100_000, 25) == 250
    assert loyalty.points_for(99_999, 25) == 249
    assert loyalty.points_for(100_000, 200) == 2000
    assert loyalty.points_for(0, 25) == 0


def test_progress_at_top_has_no_next_level():
    top = loyalty.progress(2_000_000)
    assert top["next_level"] is None
    assert top["ratio"] == 1.0

    mid = loyalty.progress(150_000)
    assert mid["next_level"]["key"] == "gold"
    assert mid["to_next"] == 250_000


# ---------------------------------------------------------------- журнал


def test_balance_and_spent_come_from_journal(ctx):
    _client, db, user, _other = ctx
    loyalty.record(db, user_id=user.id, kind="purchase", amount=100_000)
    db.commit()

    summary = loyalty.summary(db, user.id)
    assert summary["balance"] == 250            # 0,25% стартовой ставки
    assert summary["lifetime_spent"] == 100_000
    assert summary["level"]["key"] == "start"


def test_spending_points_does_not_lower_level(ctx):
    """Потратил баллы — уровень не упал: уровень про покупки, а не про счёт."""
    _client, db, user, _other = ctx
    loyalty.record(db, user_id=user.id, kind="purchase", amount=500_000)
    db.commit()
    before = loyalty.summary(db, user.id)
    assert before["level"]["key"] == "gold"

    loyalty.record(db, user_id=user.id, kind="spend", points=-1000, comment="скидка по сделке")
    db.commit()
    after = loyalty.summary(db, user.id)
    assert after["balance"] == before["balance"] - 1000
    assert after["lifetime_spent"] == 500_000
    assert after["level"]["key"] == "gold"


def test_rate_is_snapshotted_at_the_moment_of_purchase(ctx):
    """Ставка сохраняется в строке: через полгода нужно знать, по какой
    начислили, а не по какой начислили бы сегодня."""
    _client, db, user, _other = ctx
    first = loyalty.record(db, user_id=user.id, kind="purchase", amount=400_000)
    db.commit()
    second = loyalty.record(db, user_id=user.id, kind="purchase", amount=100_000)
    db.commit()

    assert first.rate_bps == 25    # покупал ещё на «Старте»
    assert first.points == 1000
    assert second.rate_bps == 100  # к этому моменту уже «Золото»
    assert second.points == 1000


def test_balance_cannot_go_negative(ctx):
    _client, db, user, _other = ctx
    loyalty.record(db, user_id=user.id, kind="bonus", points=100)
    db.commit()

    with pytest.raises(loyalty.LoyaltyError):
        loyalty.record(db, user_id=user.id, kind="spend", points=-101, comment="перебор")


def test_correction_may_drive_balance_negative(ctx):
    """Откат несостоявшейся сделки обязан пройти, даже если баллы потрачены.

    Иначе накрутка защищена собственной защитой магазина: потратил начисленное
    — и отнять уже нельзя. Отрицательный баланс честнее молчания: он виден и
    гасится из будущих начислений.
    """
    _client, db, user, _other = ctx
    loyalty.record(db, user_id=user.id, kind="bonus", points=1000)
    loyalty.record(db, user_id=user.id, kind="spend", points=-900, comment="потратил")
    db.commit()
    assert loyalty.summary(db, user.id)["balance"] == 100

    loyalty.record(
        db, user_id=user.id, kind="correction", points=-1000,
        comment="заявка 42 вышла из статуса «завершена»",
    )
    db.commit()
    assert loyalty.summary(db, user.id)["balance"] == -900


def test_spend_still_cannot_drive_balance_negative(ctx):
    """Послабление касается ТОЛЬКО корректировок: потратить больше, чем есть,
    по-прежнему нельзя."""
    _client, db, user, _other = ctx
    loyalty.record(db, user_id=user.id, kind="bonus", points=100)
    db.commit()
    with pytest.raises(loyalty.LoyaltyError):
        loyalty.record(
            db, user_id=user.id, kind="spend", points=-500, comment="слишком много",
        )


def test_spend_and_correction_require_comment(ctx):
    _client, db, user, _other = ctx
    loyalty.record(db, user_id=user.id, kind="bonus", points=500)
    db.commit()
    with pytest.raises(loyalty.LoyaltyError):
        loyalty.record(db, user_id=user.id, kind="spend", points=-10, comment="  ")


def test_referral_kind_keeps_rate_snapshot(ctx):
    """Ставка выплаты настраивается и со временем меняется — в операции
    остаётся та, по которой заплатили на самом деле."""
    _client, db, user, _other = ctx
    row = loyalty.record(
        db, user_id=user.id, kind="referral", points=1000, rate_bps=100,
        comment="1% с покупки друга",
    )
    db.commit()
    assert row.kind == "referral"
    assert row.rate_bps == 100
    assert row.amount is None


def test_referral_does_not_move_turnover(ctx):
    """Реферальный доход не поднимает уровень: иначе уровень перестанет
    означать «сколько человек у нас купил»."""
    _client, db, user, _other = ctx
    loyalty.record(
        db, user_id=user.id, kind="referral", points=200_000, rate_bps=100,
        comment="процент",
    )
    db.commit()
    assert loyalty.summary(db, user.id)["lifetime_spent"] == 0
    assert loyalty.summary(db, user.id)["level"]["key"] == "start"


def test_only_purchase_moves_turnover(ctx):
    """Подарочный бонус, поднимающий уровень, означал бы, что уровень больше
    не про покупки."""
    _client, db, user, _other = ctx
    with pytest.raises(loyalty.LoyaltyError):
        loyalty.record(db, user_id=user.id, kind="bonus", points=10, amount=500_000)


def test_idempotency_key_prevents_double_cashback(ctx):
    _client, db, user, _other = ctx
    first = loyalty.record(
        db, user_id=user.id, kind="purchase", amount=100_000, idempotency_key="click-1"
    )
    db.commit()
    second = loyalty.record(
        db, user_id=user.id, kind="purchase", amount=100_000, idempotency_key="click-1"
    )
    db.commit()

    assert first.id == second.id
    assert loyalty.summary(db, user.id)["balance"] == 250
    assert db.query(LoyaltyTransaction).count() == 1


def test_idempotency_key_is_per_user(ctx):
    """Глобально уникальный ключ позволил бы чужому клиенту занять значение."""
    _client, db, user, other = ctx
    loyalty.record(db, user_id=user.id, kind="bonus", points=10, idempotency_key="same")
    loyalty.record(db, user_id=other.id, kind="bonus", points=20, idempotency_key="same")
    db.commit()

    assert loyalty.summary(db, user.id)["balance"] == 10
    assert loyalty.summary(db, other.id)["balance"] == 20


def test_totals_returns_zero_for_users_without_operations(ctx):
    _client, db, user, other = ctx
    stats = loyalty.totals(db, [user.id, other.id])
    assert stats[user.id] == {"balance": 0, "lifetime_spent": 0.0}
    assert stats[other.id]["balance"] == 0


def test_deleting_user_removes_their_journal(ctx):
    """Нет пользователя — нет и его баллов (CASCADE).

    SQLite не следит за внешними ключами без явной PRAGMA, поэтому включаем её
    здесь: иначе тест зелёный на любом DDL и не проверяет ровно то, ради чего
    написан. В проде (PostgreSQL) ограничение работает всегда.
    """
    _client, db, user, _other = ctx
    loyalty.record(db, user_id=user.id, kind="bonus", points=10)
    db.commit()
    db.execute(text("PRAGMA foreign_keys=ON"))
    db.delete(db.get(User, user.id))
    db.commit()
    assert db.query(LoyaltyTransaction).count() == 0


# ---------------------------------------------------------------- API


def test_me_returns_own_account_only(ctx):
    """user_id в параметрах не принимается вовсе — чужой счёт не виден."""
    client, db, user, other = ctx
    loyalty.record(db, user_id=user.id, kind="bonus", points=10)
    loyalty.record(db, user_id=other.id, kind="purchase", amount=1_000_000)
    db.commit()

    data = client.get(f"/api/loyalty/me?user_id={other.id}").json()
    assert data["balance"] == 10
    assert data["lifetime_spent"] == 0
    assert data["level"]["key"] == "start"
    assert len(data["history"]) == 1
    assert [l["key"] for l in data["levels"]][0] == "start"


def test_me_requires_auth(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    try:
        assert TestClient(app).get("/api/loyalty/me").status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_admin_can_add_purchase_and_see_it_in_list(ctx):
    client, db, user, _other = ctx
    created = client.post(
        f"/api/admin/users/{user.id}/loyalty",
        json={"kind": "purchase", "amount": 200_000},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["transaction"]["points"] == 500
    assert body["balance"] == 500

    row = next(r for r in client.get("/api/admin/users").json()["users"] if r["id"] == user.id)
    assert row["balance"] == 500
    assert row["lifetime_spent"] == 200_000
    assert row["level"]["key"] == "silver"


def test_admin_can_override_calculated_points(ctx):
    """Расчёт предлагается, а не навязывается."""
    client, db, user, _other = ctx
    body = client.post(
        f"/api/admin/users/{user.id}/loyalty",
        json={"kind": "purchase", "amount": 100_000, "points": 1000, "comment": "акция"},
    ).json()
    assert body["transaction"]["points"] == 1000


def test_admin_overspend_is_rejected_with_422(ctx):
    client, db, user, _other = ctx
    resp = client.post(
        f"/api/admin/users/{user.id}/loyalty",
        json={"kind": "spend", "points": -50, "comment": "списание"},
    )
    assert resp.status_code == 422
    assert loyalty.summary(db, user.id)["balance"] == 0


def test_admin_detail_has_history_and_progress(ctx):
    client, db, user, _other = ctx
    client.post(f"/api/admin/users/{user.id}/loyalty", json={"kind": "purchase", "amount": 100_000})

    data = client.get(f"/api/admin/users/{user.id}").json()
    assert data["balance"] == 250
    assert data["progress"]["next_level"]["key"] == "silver"
    assert data["progress"]["to_next"] == 50_000
    assert len(data["history"]) == 1
    assert data["history"][0]["created_by"] == "admin@test.local"


def test_admin_search_finds_user_by_username(ctx):
    client, _db, user, _other = ctx
    rows = client.get("/api/admin/users?q=garik").json()["users"]
    assert [r["id"] for r in rows] == [user.id]


def test_admin_users_requires_admin(db):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    try:
        assert TestClient(app).get("/api/admin/users").status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_admin_rejects_unknown_kind(ctx):
    client, _db, user, _other = ctx
    resp = client.post(
        f"/api/admin/users/{user.id}/loyalty", json={"kind": "give_everything", "points": 10}
    )
    assert resp.status_code == 422
