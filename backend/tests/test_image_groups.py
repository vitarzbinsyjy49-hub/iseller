"""v5.2.6 — канонический ключ группы изображений (модель + цвет).

Проверяет главный принцип: галерея зависит ТОЛЬКО от модели и цвета, а
память/накопитель/RAM не влияют. Разные цвета/модели/поколения — разные группы.
"""
from app.services.image_groups import (
    image_group_key as key,
    normalize_color,
    normalize_model,
)


# ---------- 1: одинаковая модель + цвет, разная память -> один ключ ----------

def test_same_model_color_different_memory_same_key():
    k128 = key("Apple", "iPhone 16 Pro 128 ГБ Black")
    k256 = key("Apple", "iPhone 16 Pro 256 ГБ Black")
    k512 = key("Apple", "iPhone 16 Pro 512 ГБ Black")
    assert k128 == k256 == k512
    assert k128 is not None


def test_memory_in_structured_field_not_in_key():
    # память в отдельном поле, не в title — тоже не влияет
    a = key("Apple", "iPhone 16 Pro Black", color="Black", memory="128 ГБ")
    b = key("Apple", "iPhone 16 Pro Black", color="Black", memory="512 ГБ")
    assert a == b is not None


# ---------- 2: одинаковая модель, разный цвет -> разные ключи ----------

def test_same_model_different_color_different_key():
    black = key("Apple", "iPhone 16 Pro 256 ГБ Black")
    white = key("Apple", "iPhone 16 Pro 256 ГБ White")
    assert black != white
    assert black and white


# ---------- 3: Pro и Pro Max -> разные группы ----------

def test_pro_vs_pro_max_different():
    pro = key("Apple", "iPhone 16 Pro 256 ГБ Black")
    pro_max = key("Apple", "iPhone 16 Pro Max 256 ГБ Black")
    assert pro != pro_max


# ---------- 4: разное поколение -> разные группы ----------

def test_different_generation_different():
    assert key("Apple", "iPhone 15 Pro 256 ГБ Black") != key("Apple", "iPhone 16 Pro 256 ГБ Black")
    # чип MacBook = поколение
    assert key("Apple", "MacBook Air 13 M2 8/256 Midnight") != key("Apple", "MacBook Air 13 M3 8/256 Midnight")


# ---------- 5: MacBook разной RAM/SSD, одна модель+цвет -> одна группа ----------

def test_macbook_different_ram_ssd_same_group():
    a = key("Apple", "MacBook Air M4 16/256 Midnight")
    b = key("Apple", "MacBook Air M4 24/512 Midnight")
    assert a == b is not None


# ---------- цвет из RU/EN синонимов ----------

def test_color_ru_en_synonyms_merge():
    assert normalize_color("Чёрный") == normalize_color("Black") == "black"
    assert normalize_color("Space Gray") == normalize_color("серый космос") == "space gray"
    # title на русском и поле на английском дают один ключ
    assert key("Apple", "iPhone 16 Pro 256 ГБ", color="Чёрный") == key("Apple", "iPhone 16 Pro 128 ГБ Black")


def test_titanium_multiword_colors_distinct():
    nat = key("Apple", "iPhone 16 Pro 256 ГБ Natural Titanium")
    blk = key("Apple", "iPhone 16 Pro 256 ГБ Black Titanium")
    assert nat != blk and nat and blk


# ---------- размер корпуса меняет внешний вид -> разные группы ----------

def test_watch_case_size_distinct():
    assert key("Apple", "Apple Watch Series 10 42mm Midnight") != key(
        "Apple", "Apple Watch Series 10 46mm Midnight"
    )


# ---------- недостаточно данных -> ключа нет (товар не группируется) ----------

def test_no_color_no_key():
    # сид-товары без цвета в title и без поля color
    assert key("Apple", "iPhone 15 Pro 128 ГБ") is None
    assert key("Apple", "MacBook Air 13 M2 8/256") is None


def test_no_brand_no_key():
    assert key("", "iPhone 16 Pro 256 ГБ Black") is None


# ---------- normalize_model чистит только варьирующее ----------

def test_normalize_model_strips_variant_keeps_identity():
    assert normalize_model("iPhone 16 Pro 256 ГБ Black", color_raw="Black") == "iphone 16 pro"
    assert normalize_model("MacBook Air M4 16/256 Midnight", color_raw="Midnight") == "macbook air m4"
    assert normalize_model("PlayStation 5 Slim 1 ТБ") == "playstation 5 slim"
    # размер/mm остаётся частью модели
    assert "46mm" in normalize_model("Apple Watch Series 10 46mm")
