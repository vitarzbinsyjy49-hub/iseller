"""Резолвер доступности товара — правила корзины в одном месте.

Главное, что здесь проверяется: NULL в ``availability_mode`` НЕ меняет поведение
существующих товаров. Вся миграция построена на этом — если вывод из флагов
поедет, 217 товаров прода поменяют режим молча.
"""
from app.models.product import Product
from app.services.availability import (
    MAX_ITEM_QUANTITY,
    availability_payload,
    clamp_quantity,
    is_orderable,
    max_quantity,
    resolve_availability,
)


def p(**kw) -> Product:
    """Товар в памяти (без БД): резолвер — чистая функция от полей."""
    defaults = dict(title="X", price=1000, is_active=True, in_stock=True,
                    stock=5, is_limited=False, availability_mode=None)
    defaults.update(kw)
    return Product(**defaults)


# ---- вывод из флагов (availability_mode = NULL) ----
def test_plain_in_stock_product_is_in_stock():
    assert resolve_availability(p()) == "in_stock"


def test_not_in_stock_is_on_request_not_out_of_stock():
    """«Под заказ» — то, что витрина показывает для in_stock=False сегодня.
    Превратить это в out_of_stock значило бы запретить заявки на 100+ позиций."""
    assert resolve_availability(p(in_stock=False, stock=0)) == "on_request"


def test_limited_flag_gives_limited_mode():
    assert resolve_availability(p(is_limited=True, stock=3)) == "limited"


def test_inactive_product_is_unavailable_whatever_the_flags():
    assert resolve_availability(p(is_active=False, in_stock=True)) == "unavailable"


def test_missing_product_is_unavailable():
    assert resolve_availability(None) == "unavailable"


# ---- явный режим ----
def test_explicit_mode_wins_over_flags():
    assert resolve_availability(p(in_stock=True, availability_mode="preorder")) == "preorder"
    assert resolve_availability(p(in_stock=True, availability_mode="out_of_stock")) == "out_of_stock"


def test_explicit_mode_cannot_resurrect_hidden_product():
    """is_active=False перебивает явный режим: второго выключателя нет."""
    assert resolve_availability(p(is_active=False, availability_mode="in_stock")) == "unavailable"


def test_unknown_explicit_mode_falls_back_to_flags():
    assert resolve_availability(p(availability_mode="whatever")) == "in_stock"


# ---- что можно заказать ----
def test_orderable_modes():
    assert is_orderable("in_stock") and is_orderable("limited")
    assert is_orderable("preorder") and is_orderable("on_request")
    assert not is_orderable("out_of_stock")
    assert not is_orderable("unavailable")


# ---- количество ----
def test_limited_quantity_capped_by_stock():
    product = p(is_limited=True, stock=3)
    assert max_quantity(product) == 3
    assert clamp_quantity(product, 10) == 3
    assert clamp_quantity(product, 2) == 2


def test_limited_with_zero_stock_still_allows_one():
    """Партия кончилась, но товар помечен лимитированным — не роняем в 0:
    ноль означал бы «нельзя», а решение о доступности принимает режим."""
    assert max_quantity(p(is_limited=True, stock=0)) == 1


def test_on_request_ignores_stock():
    """У «под заказ» склад пуст по определению — ограничивать им нечего."""
    assert max_quantity(p(in_stock=False, stock=0)) == MAX_ITEM_QUANTITY


def test_quantity_never_below_one_and_never_above_limit():
    product = p()
    assert clamp_quantity(product, 0) == 1
    assert clamp_quantity(product, -5) == 1
    assert clamp_quantity(product, 999) == MAX_ITEM_QUANTITY
    assert clamp_quantity(product, "не число") == 1


def test_unorderable_product_has_zero_max_quantity():
    assert max_quantity(p(availability_mode="out_of_stock")) == 0
    assert clamp_quantity(p(is_active=False), 3) == 0


# ---- payload для API ----
def test_payload_shape():
    data = availability_payload(p(is_limited=True, stock=2))
    assert data["availability_mode"] == "limited"
    assert data["orderable"] is True
    assert data["max_quantity"] == 2
    assert data["availability_label"] and data["availability_note"]


def test_payload_for_plain_product_has_no_noise_note():
    """Обычный товар в наличии не нуждается в пояснении — пустая строка, а не
    выдуманная подпись."""
    assert availability_payload(p())["availability_note"] == ""
