"""to_card() отдаёт condition — нужно для бейджа «Б/у» на витрине."""
from tests.conftest import make_product


def test_to_card_includes_condition(db):
    p = make_product(db, condition="used")
    card = p.to_card()
    assert card["condition"] == "used"


def test_to_card_condition_defaults_to_new(db):
    p = make_product(db)  # condition по умолчанию "new" (см. conftest.make_product)
    card = p.to_card()
    assert card["condition"] == "new"
