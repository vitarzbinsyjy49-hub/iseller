"""«Легендарный» товар: закреплён первым и помечен на карточке.

Это витринный инструмент для редких позиций — комплектов и эксклюзивов, ради
которых человек и приходит. От «хита» отличается тем, что легендарный товар не
участвует в общем соревновании за место: он закреплён наверху выдачи, сколько бы
популярности ни набрали остальные.

Поэтому флаг СТАРШЕ всех прочих ключей сортировки, включая наличие: снятый с
продажи легендарный товар должен пропасть из каталога через `is_active`, а не
провалиться вниз молча.
"""
from app.models.home import HomeCategory
from app.services.ranking import category_priority, product_sort_key
from tests.conftest import make_product


def _tile(db, title, value, position):
    db.add(HomeCategory(title=title, action_type="category", action_value=value, position=position))
    db.commit()


def _order(db, products):
    prio = category_priority(db)
    return [p.title for p in sorted(products, key=lambda p: product_sort_key(p, prio))]


def test_legendary_pinned_above_everything(db):
    _tile(db, "Смартфоны", "смартфоны", 1)
    _tile(db, "Консоли", "консоли", 5)
    items = [
        make_product(db, title="iPhone", category="смартфоны", popularity=99, price=200000),
        make_product(db, title="Комплект PS5 Pro", category="консоли", popularity=0,
                     price=104999, is_legendary=True),
    ]
    assert _order(db, items)[0] == "Комплект PS5 Pro"


def test_two_legendary_keep_the_usual_order_between_themselves(db):
    """Закрепление поднимает наверх, но не отменяет правила ВНУТРИ группы."""
    _tile(db, "Смартфоны", "смартфоны", 1)
    _tile(db, "Консоли", "консоли", 5)
    items = [
        make_product(db, title="Легендарная консоль", category="консоли",
                     popularity=0, price=104999, is_legendary=True),
        make_product(db, title="Легендарный смартфон", category="смартфоны",
                     popularity=0, price=90000, is_legendary=True),
        make_product(db, title="Обычный iPhone", category="смартфоны", popularity=99, price=200000),
    ]
    assert _order(db, items) == [
        "Легендарный смартфон",     # категория выше по плиткам
        "Легендарная консоль",
        "Обычный iPhone",
    ]


def test_legendary_out_of_stock_still_pinned(db):
    """Нет в наличии — не повод тихо уронить закреплённый товар вниз списка:
    скрывать его надо осознанно, через is_active."""
    _tile(db, "Консоли", "консоли", 5)
    items = [
        make_product(db, title="Обычная в наличии", category="консоли", popularity=50),
        make_product(db, title="Легендарная под заказ", category="консоли",
                     popularity=0, is_legendary=True, in_stock=False),
    ]
    assert _order(db, items)[0] == "Легендарная под заказ"


def test_flag_is_off_by_default_and_reaches_the_card(db):
    plain = make_product(db, title="Обычный")
    rare = make_product(db, title="Редкий", is_legendary=True)
    assert plain.is_legendary is False
    assert plain.to_card()["is_legendary"] is False
    assert rare.to_card()["is_legendary"] is True
    assert rare.to_admin()["is_legendary"] is True


def test_poster_reaches_the_detail_page_but_not_the_card(db):
    """Афиша события — широкий макет, а не снимок товара.

    В ленте карточка квадратная, и постер там обрезался бы по центру, теряя и
    заголовок, и цену. Поэтому афиша живёт отдельным полем и доезжает только до
    страницы товара, где под неё есть вся ширина.
    """
    p = make_product(db, title="Комплект", is_legendary=True,
                     poster_url="/assets/promos/gta6-ps5-pro-bundle-v3.webp")
    assert p.to_detail()["poster_url"] == "/assets/promos/gta6-ps5-pro-bundle-v3.webp"
    assert "poster_url" not in p.to_card()
    assert p.to_admin()["poster_url"] == "/assets/promos/gta6-ps5-pro-bundle-v3.webp"


def test_poster_is_empty_by_default(db):
    """Обычный товар без афиши отдаёт None, а не пустую строку: страница
    решает по «есть/нет», и None здесь однозначнее."""
    assert make_product(db, title="Обычный").to_detail()["poster_url"] is None


def test_legendary_suppresses_the_hot_badge(db):
    """Два «важных» шильдика на одной карточке спорят между собой. Легендарный
    старше — «Хит» на нём не показываем, иначе оранжевый мутит золото."""
    p = make_product(db, title="Комплект", is_legendary=True, is_hot=True)
    card = p.to_card()
    assert card["is_legendary"] is True
    assert card["is_hot"] is False
