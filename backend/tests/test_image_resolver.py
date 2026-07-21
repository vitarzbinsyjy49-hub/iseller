"""v5.2.6 — resolver галерей и выбор representative.

Проверяет цепочку источников (группа -> свои -> сосед -> placeholder), detach,
обратную совместимость легаси-фото и дедуп вариантов одной модели+цвета.
"""
from app.models.product_image_group import ProductImageGroup
from app.services.image_groups import dedupe_by_group, resolve_product_images
from tests.conftest import make_product


def _group(db, key, images):
    g = ProductImageGroup(key=key, images=images, image=images[0] if images else None)
    db.add(g)
    db.commit()
    return g


def test_group_gallery_used_for_all_variants(db):
    p128 = make_product(db, title="iPhone 16 Pro 128 ГБ Black", color="Black", price=100000)
    p256 = make_product(db, title="iPhone 16 Pro 256 ГБ Black", color="Black", price=110000)
    assert p128.image_group_key == p256.image_group_key is not None
    _group(db, p128.image_group_key, ["/g/a.webp", "/g/b.webp"])
    res = resolve_product_images(db, [p128, p256])
    assert res[p128.id]["images"] == ["/g/a.webp", "/g/b.webp"]
    assert res[p256.id]["image"] == "/g/a.webp"  # оба варианта -> одна галерея


def test_own_images_when_no_group(db):
    p = make_product(db, title="iPhone 16 Pro 128 ГБ Black", color="Black",
                     image="/own/main.webp", images=["/own/main.webp", "/own/2.webp"])
    res = resolve_product_images(db, [p])
    assert res[p.id]["images"] == ["/own/main.webp", "/own/2.webp"]  # легаси-фото работают


def test_detached_uses_own_over_group(db):
    p = make_product(db, title="iPhone 16 Pro 128 ГБ Black", color="Black",
                     image="/own/m.webp", images=["/own/m.webp"], image_group_detached=True)
    _group(db, p.image_group_key, ["/g/a.webp"])
    res = resolve_product_images(db, [p])
    assert res[p.id]["images"] == ["/own/m.webp"]  # отвязанный товар игнорирует группу


def test_sibling_fallback(db):
    withimg = make_product(db, title="iPhone 16 Pro 256 ГБ Black", color="Black",
                           image="/sib/m.webp", images=["/sib/m.webp"])
    noimg = make_product(db, title="iPhone 16 Pro 128 ГБ Black", color="Black")
    assert withimg.image_group_key == noimg.image_group_key
    res = resolve_product_images(db, [noimg])
    assert res[noimg.id]["images"] == ["/sib/m.webp"]  # фото соседа той же модели+цвета


def test_placeholder_when_nothing(db):
    p = make_product(db, title="iPhone 16 Pro 128 ГБ Black", color="Black")
    res = resolve_product_images(db, [p])
    assert res[p.id] == {"image": None, "images": []}  # -> нейтральный placeholder на фронте


def test_never_takes_other_color_photos(db):
    black_noimg = make_product(db, title="iPhone 16 Pro 128 ГБ Black", color="Black")
    make_product(db, title="iPhone 16 Pro 256 ГБ White", color="White",
                 image="/white/m.webp", images=["/white/m.webp"])
    res = resolve_product_images(db, [black_noimg])
    assert res[black_noimg.id]["images"] == []  # чужой цвет НЕ подставляется


def test_dedupe_keeps_one_representative(db):
    p128 = make_product(db, title="iPhone 16 Pro 128 ГБ Black", color="Black", price=100000, in_stock=True)
    p256 = make_product(db, title="iPhone 16 Pro 256 ГБ Black", color="Black", price=110000, in_stock=True)
    p512 = make_product(db, title="iPhone 16 Pro 512 ГБ Black", color="Black", price=130000, in_stock=True)
    white = make_product(db, title="iPhone 16 Pro 256 ГБ White", color="White", price=110000)
    out = dedupe_by_group([p256, p512, p128, white])
    assert len(out) == 2  # один Black + один White (память не плодит дубли)
    black = [p for p in out if p.color == "Black"][0]
    assert black.id == p128.id  # representative = в наличии + минимальная цена


def test_dedupe_products_without_key_not_grouped(db):
    a = make_product(db, title="AirPods Max")     # без цвета -> нет ключа
    b = make_product(db, title="AirPods Pro 2")
    assert a.image_group_key is None and b.image_group_key is None
    assert len(dedupe_by_group([a, b])) == 2
