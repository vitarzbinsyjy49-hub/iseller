"""Демо-каталог: 30 товаров для показа заказчику (Demo MVP v2).

Запуск: docker compose -f docker-compose.demo.yml exec backend python -m app.scripts.seed_products
Идемпотентно: если товары уже есть — не дублирует.

Картинки — стабильные публичные placeholder-URL (светлые, под светлый UI).
Если картинка недоступна, фронтенд показывает градиентную заглушку и не ломается.
"""
from sqlalchemy import func, select

from app.db.session import Base, SessionLocal, engine
from app.models.product import Product


# Локальные SVG-заглушки (frontend/public/assets/placeholders) — вместо внешнего
# dummyimage.com: не зависят от сети и выглядят аккуратно в светлом UI.
_PLACEHOLDERS = {
    "смартфоны": "/assets/placeholders/smartphones.svg",
    "ноутбуки": "/assets/placeholders/laptops.svg",
    "планшеты": "/assets/placeholders/tablets.svg",
    "наушники": "/assets/placeholders/headphones.svg",
    "консоли": "/assets/placeholders/consoles.svg",
    "dyson": "/assets/placeholders/dyson.svg",
    "аксессуары": "/assets/placeholders/accessories.svg",
}


def img(category: str | None) -> str:
    return _PLACEHOLDERS.get((category or "").lower(), "/assets/placeholders/product.svg")


# Транслит для генерации SKU из названия (в демо-каталоге кириллицы немного)
_TRANSLIT = str.maketrans({
    "а": "A", "б": "B", "в": "V", "г": "G", "д": "D", "е": "E", "ж": "ZH", "з": "Z",
    "и": "I", "й": "Y", "к": "K", "л": "L", "м": "M", "н": "N", "о": "O", "п": "P",
    "р": "R", "с": "S", "т": "T", "у": "U", "ф": "F", "х": "H", "ц": "C", "ч": "CH",
    "ш": "SH", "щ": "SCH", "ъ": "", "ы": "Y", "ь": "", "э": "E", "ю": "YU", "я": "YA",
})


def make_sku(title: str) -> str:
    """'iPhone 15 Pro 128 ГБ' -> 'IPHONE15PRO128GB' — детерминированный SKU для демо."""
    s = title.lower().translate(_TRANSLIT)
    return "".join(ch for ch in s.upper() if ch.isalnum())[:64]


P = [
    # ---------- Смартфоны ----------
    dict(title="iPhone 15 Pro 128 ГБ", brand="Apple", category="смартфоны", price=89990, old_price=99990,
         stock=14, rating=4.9, popularity=98, margin_pct=8, is_new=False, on_sale=True, is_hot=True,
         is_available_today=True, warranty_months=1, tags=["хит", "титан"],
         description="iPhone 15 Pro в титановом корпусе: чип A17 Pro, камера 48 Мп, лёгкий и мощный.",
         specs={"экран": "6.1\" Super Retina XDR", "память": "128 ГБ", "чип": "A17 Pro", "камера": "48 Мп"}),
    dict(title="iPhone 15 Pro 256 ГБ", brand="Apple", category="смартфоны", price=99990, old_price=109990,
         stock=9, rating=4.9, popularity=96, margin_pct=8, is_new=False, on_sale=True, is_hot=True,
         is_available_today=True, warranty_months=1, tags=["хит", "титан"],
         description="Версия iPhone 15 Pro с увеличенной памятью 256 ГБ — для фото, видео и игр.",
         specs={"экран": "6.1\" Super Retina XDR", "память": "256 ГБ", "чип": "A17 Pro", "камера": "48 Мп"}),
    dict(title="iPhone 16 128 ГБ", brand="Apple", category="смартфоны", price=84990, old_price=None,
         stock=18, rating=4.8, popularity=94, margin_pct=9, is_new=True, on_sale=False, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["новинка"],
         description="Новый iPhone 16 с чипом A18, кнопкой Camera Control и улучшенной автономностью.",
         specs={"экран": "6.1\" OLED", "память": "128 ГБ", "чип": "A18", "камера": "48 Мп"}),
    dict(title="iPhone 16 Pro 256 ГБ", brand="Apple", category="смартфоны", price=119990, old_price=129990,
         stock=7, rating=4.9, popularity=99, margin_pct=8, is_new=True, on_sale=True, is_hot=True,
         is_available_today=True, warranty_months=1, tags=["флагман", "новинка"],
         description="Флагман Apple: A18 Pro, титановый корпус, камера 48 Мп с 5x-зумом.",
         specs={"экран": "6.3\" OLED 120 Гц", "память": "256 ГБ", "чип": "A18 Pro", "камера": "48 Мп + 5x"}),
    dict(title="Samsung Galaxy S24 256 ГБ", brand="Samsung", category="смартфоны", price=69990, old_price=79990,
         stock=15, rating=4.7, popularity=90, margin_pct=11, is_new=False, on_sale=True, is_hot=True,
         is_available_today=True, warranty_months=1, tags=["Galaxy AI"],
         description="Компактный флагман Samsung с Galaxy AI, ярким экраном и отличными камерами.",
         specs={"экран": "6.2\" AMOLED 120 Гц", "память": "256 ГБ", "чип": "Exynos 2400", "АКБ": "4000 мАч"}),
    dict(title="Samsung Galaxy Z Flip6", brand="Samsung", category="смартфоны", price=89990, old_price=99990,
         stock=5, rating=4.6, popularity=82, margin_pct=12, is_new=True, on_sale=True, is_hot=False,
         is_available_today=False, warranty_months=1, tags=["складной"],
         description="Стильная раскладушка: компактная в кармане, большой экран в работе.",
         specs={"экран": "6.7\" складной AMOLED", "память": "256 ГБ", "чип": "Snapdragon 8 Gen 3"}),

    # ---------- Ноутбуки ----------
    dict(title="MacBook Air 13 M2 8/256", brand="Apple", category="ноутбуки", price=94990, old_price=104990,
         stock=11, rating=4.8, popularity=93, margin_pct=9, is_new=False, on_sale=True, is_hot=True,
         is_available_today=True, warranty_months=1, tags=["для работы", "лёгкий"],
         description="Тонкий и бесшумный MacBook Air на M2 — идеален для учёбы и работы.",
         specs={"экран": "13.6\" Liquid Retina", "чип": "Apple M2", "память": "8/256 ГБ", "вес": "1.24 кг"}),
    dict(title="MacBook Air 13 M3 8/256", brand="Apple", category="ноутбуки", price=109990, old_price=None,
         stock=8, rating=4.9, popularity=91, margin_pct=9, is_new=True, on_sale=False, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["новинка", "для работы"],
         description="MacBook Air на новом чипе M3: быстрее в монтаже, до 18 часов автономности.",
         specs={"экран": "13.6\" Liquid Retina", "чип": "Apple M3", "память": "8/256 ГБ", "вес": "1.24 кг"}),
    dict(title="MacBook Pro 14 M3 Pro 18/512", brand="Apple", category="ноутбуки", price=189990, old_price=209990,
         stock=4, rating=4.9, popularity=88, margin_pct=7, is_new=False, on_sale=True, is_hot=True,
         is_available_today=False, warranty_months=1, tags=["для монтажа", "профи"],
         description="Профессиональный MacBook Pro 14 на M3 Pro — монтаж 4K-видео без прокси.",
         specs={"экран": "14.2\" Liquid Retina XDR 120 Гц", "чип": "M3 Pro", "память": "18/512 ГБ"}),
    dict(title="ASUS ROG Zephyrus G14 RTX 4060", brand="ASUS", category="ноутбуки", price=149990, old_price=164990,
         stock=6, rating=4.7, popularity=85, margin_pct=10, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["игровой", "для монтажа"],
         description="Компактный игровой ноутбук: Ryzen 9, RTX 4060, экран 120 Гц — тянет и игры, и монтаж.",
         specs={"экран": "14\" 2560×1600 120 Гц", "CPU": "Ryzen 9", "GPU": "RTX 4060", "память": "16/1024 ГБ"}),
    dict(title="Lenovo Legion 5 Pro RTX 4070", brand="Lenovo", category="ноутбуки", price=139990, old_price=154990,
         stock=7, rating=4.6, popularity=83, margin_pct=11, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["игровой"],
         description="Игровая классика: мощная RTX 4070, эффективное охлаждение, экран 165 Гц.",
         specs={"экран": "16\" 2560×1600 165 Гц", "CPU": "Ryzen 7", "GPU": "RTX 4070", "память": "16/1024 ГБ"}),

    # ---------- Планшеты ----------
    dict(title="iPad Air 11 M2 128 ГБ", brand="Apple", category="планшеты", price=64990, old_price=69990,
         stock=10, rating=4.8, popularity=87, margin_pct=10, is_new=True, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["для учёбы", "для рисования"],
         description="iPad Air на M2 — универсальный планшет для заметок, рисования и развлечений.",
         specs={"экран": "11\" Liquid Retina", "чип": "Apple M2", "память": "128 ГБ", "Pencil": "Pro"}),
    dict(title="iPad Pro 11 M4 256 ГБ", brand="Apple", category="планшеты", price=99990, old_price=None,
         stock=5, rating=4.9, popularity=84, margin_pct=8, is_new=True, on_sale=False, is_hot=False,
         is_available_today=False, warranty_months=1, tags=["OLED", "профи"],
         description="Самый тонкий iPad Pro с OLED-экраном Ultra Retina XDR и чипом M4.",
         specs={"экран": "11\" Ultra Retina XDR OLED", "чип": "Apple M4", "память": "256 ГБ"}),

    # ---------- Наушники ----------
    dict(title="AirPods Pro 2 (USB-C)", brand="Apple", category="наушники", price=19990, old_price=24990,
         stock=25, rating=4.8, popularity=95, margin_pct=15, is_new=False, on_sale=True, is_hot=True,
         is_available_today=True, warranty_months=1, tags=["шумодав", "хит"],
         description="Лучшее шумоподавление в TWS: адаптивный режим, кейс с USB-C.",
         specs={"тип": "TWS", "шумоподавление": "активное", "кейс": "USB-C, MagSafe"}),
    dict(title="AirPods Max", brand="Apple", category="наушники", price=54990, old_price=62990,
         stock=4, rating=4.7, popularity=78, margin_pct=12, is_new=False, on_sale=True, is_hot=False,
         is_available_today=False, warranty_months=1, tags=["премиум"],
         description="Полноразмерные наушники Apple с эталонным звуком и шумоподавлением.",
         specs={"тип": "полноразмерные", "шумоподавление": "активное", "автономность": "20 ч"}),
    dict(title="Sony WH-1000XM5", brand="Sony", category="наушники", price=32990, old_price=37990,
         stock=9, rating=4.8, popularity=86, margin_pct=14, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["шумодав"],
         description="Эталон шумоподавления от Sony: 30 часов работы, мягкие амбушюры.",
         specs={"тип": "полноразмерные", "шумоподавление": "активное", "автономность": "30 ч"}),
    dict(title="Samsung Galaxy Buds3 Pro", brand="Samsung", category="наушники", price=15990, old_price=None,
         stock=17, rating=4.5, popularity=76, margin_pct=16, is_new=True, on_sale=False, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["TWS"],
         description="Флагманские TWS Samsung с чистым звуком и умным шумоподавлением.",
         specs={"тип": "вкладыши", "шумоподавление": "активное"}),

    # ---------- Консоли ----------
    dict(title="PlayStation 5 Slim 1 ТБ", brand="Sony", category="консоли", price=54990, old_price=59990,
         stock=8, rating=4.9, popularity=97, margin_pct=7, is_new=False, on_sale=True, is_hot=True,
         is_available_today=True, warranty_months=1, tags=["хит", "для игр"],
         description="Обновлённая компактная PS5 с дисководом и SSD на 1 ТБ.",
         specs={"память": "1 ТБ SSD", "разрешение": "4K", "комплект": "геймпад DualSense"}),
    dict(title="Xbox Series X 1 ТБ", brand="Microsoft", category="консоли", price=52990, old_price=57990,
         stock=6, rating=4.8, popularity=85, margin_pct=8, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["4K", "Game Pass"],
         description="Самая мощная консоль Xbox: 4K/120 Гц и огромная библиотека Game Pass.",
         specs={"память": "1 ТБ SSD", "разрешение": "4K", "fps": "до 120"}),
    dict(title="Nintendo Switch OLED", brand="Nintendo", category="консоли", price=27990, old_price=None,
         stock=12, rating=4.7, popularity=83, margin_pct=12, is_new=False, on_sale=False, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["портатив", "для семьи"],
         description="Портативная консоль с ярким OLED-экраном — играйте дома и в дороге.",
         specs={"экран": "7\" OLED", "память": "64 ГБ", "режимы": "ТВ и портативный"}),

    # ---------- Dyson ----------
    dict(title="Dyson Airwrap Complete Long", brand="Dyson", category="dyson", price=64990, old_price=71990,
         stock=6, rating=4.8, popularity=89, margin_pct=14, is_new=False, on_sale=True, is_hot=True,
         is_available_today=True, warranty_months=1, tags=["подарок", "премиум"],
         description="Мультистайлер Dyson Airwrap: укладка потоком воздуха без экстремальных температур.",
         specs={"насадки": "6 шт", "режимы": "3 скорости, 3 температуры", "кейс": "в комплекте"}),
    dict(title="Dyson Supersonic HD08", brand="Dyson", category="dyson", price=39990, old_price=44990,
         stock=9, rating=4.8, popularity=87, margin_pct=15, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["подарок", "премиум"],
         description="Фен Dyson Supersonic: быстрая сушка с контролем температуры, без пересушивания.",
         specs={"мощность": "1600 Вт", "насадки": "5 шт", "контроль температуры": "интеллектуальный"}),

    # ---------- Часы (аксессуары) ----------
    dict(title="Apple Watch Series 10 46mm", brand="Apple", category="аксессуары", price=42990, old_price=None,
         stock=13, rating=4.8, popularity=88, margin_pct=12, is_new=True, on_sale=False, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["часы", "новинка"],
         description="Самый тонкий Apple Watch с большим экраном и быстрой зарядкой.",
         specs={"экран": "46 мм LTPO OLED", "датчики": "ЭКГ, SpO2", "влагозащита": "50 м"}),
    dict(title="Samsung Galaxy Watch7 44mm", brand="Samsung", category="аксессуары", price=24990, old_price=27990,
         stock=11, rating=4.6, popularity=79, margin_pct=14, is_new=True, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["часы"],
         description="Умные часы Samsung с точным трекингом сна и тренировок.",
         specs={"экран": "44 мм AMOLED", "датчики": "BioActive", "автономность": "до 40 ч"}),

    # ---------- Аксессуары ----------
    dict(title="Apple 20W USB-C адаптер", brand="Apple", category="аксессуары", price=1990, old_price=None,
         stock=100, rating=4.6, popularity=72, margin_pct=30, is_new=False, on_sale=False, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["зарядка"],
         description="Оригинальный адаптер быстрой зарядки для iPhone и iPad.",
         specs={"мощность": "20 Вт", "разъём": "USB-C"}),
    dict(title="Кабель USB-C — Lightning 1 м", brand="Apple", category="аксессуары", price=1490, old_price=1990,
         stock=120, rating=4.5, popularity=70, margin_pct=35, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["кабель"],
         description="Оригинальный кабель для быстрой зарядки iPhone от USB-C адаптера.",
         specs={"длина": "1 м", "разъёмы": "USB-C / Lightning"}),
    dict(title="Чехол MagSafe для iPhone 15 Pro", brand="Apple", category="аксессуары", price=4990, old_price=5990,
         stock=40, rating=4.4, popularity=66, margin_pct=40, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["чехол"],
         description="Фирменный силиконовый чехол с MagSafe — точная посадка и защита.",
         specs={"материал": "силикон", "MagSafe": "да"}),
    dict(title="Powerbank Anker 20000 мАч 30W", brand="Anker", category="аксессуары", price=4490, old_price=5490,
         stock=35, rating=4.7, popularity=74, margin_pct=28, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["powerbank"],
         description="Ёмкий повербанк с быстрой зарядкой 30 Вт — два полных заряда iPhone.",
         specs={"ёмкость": "20000 мАч", "мощность": "30 Вт", "порты": "USB-C + USB-A"}),
    dict(title="Зарядная станция 3-в-1 MagSafe", brand="Belkin", category="аксессуары", price=8990, old_price=10990,
         stock=14, rating=4.5, popularity=64, margin_pct=32, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["зарядка", "подарок"],
         description="Станция для iPhone, Apple Watch и AirPods — порядок на столе и быстрая зарядка.",
         specs={"устройства": "3", "MagSafe": "да", "мощность": "15 Вт"}),
    dict(title="JBL Charge 5 колонка", brand="JBL", category="аксессуары", price=11990, old_price=13990,
         stock=16, rating=4.6, popularity=71, margin_pct=22, is_new=False, on_sale=True, is_hot=False,
         is_available_today=True, warranty_months=1, tags=["подарок", "звук"],
         description="Портативная колонка с мощным басом и защитой от воды IP67.",
         specs={"мощность": "40 Вт", "автономность": "20 ч", "защита": "IP67"}),
]


def main() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        count = db.execute(select(func.count()).select_from(Product)).scalar_one()
        if count:
            # Апгрейд существующей демо-БД: заменяем внешние dummyimage-URL
            # на локальные placeholder'ы и заполняем пустые sku (v4: нужен для
            # импорта и матчинга фото). Реальные картинки/sku не трогаем.
            upgraded = skus = 0
            for prod in db.execute(select(Product)).scalars():
                if prod.image and "dummyimage.com" in prod.image:
                    prod.image = img(prod.category)
                    upgraded += 1
                if not prod.sku:
                    prod.sku = make_sku(prod.title)
                    skus += 1
            db.commit()
            print(f"В каталоге уже {count} товаров — сид пропущен."
                  + (f" Обновлено картинок: {upgraded}." if upgraded else "")
                  + (f" Заполнено sku: {skus}." if skus else ""))
            return
        for p in P:
            p["in_stock"] = p.get("stock", 0) > 0
            p["image"] = img(p.get("category"))
            p["is_active"] = True
            p["sku"] = make_sku(p["title"])
            p["source"] = "seed"
            db.add(Product(**p))
        db.commit()
        print(f"Добавлено {len(P)} демо-товаров.")


if __name__ == "__main__":
    main()
