# «Предложить товар» — маркетплейс Б/у Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь подаёт заявку-визард на продажу б/у техники (категория → название → состояние → цена → фото → телефон → комментарий → превью), модератор одобряет её в «Заявках» и публикует как товар; такие товары видны только в изолированном разделе «Маркетплейс» — не смешиваются с обычным каталогом/поиском/ИИ-подбором.

**Architecture:** Заявка идёт через уже существующий `POST /api/leads` (`lead_type="sell_item"`) — ни новой таблицы, ни нового CRUD-эндпоинта для заявок не заводим. Публикация — существующий `POST /admin/products` с новым значением `Product.source="user_submitted"`. Изоляция от обычного каталога — один переиспользуемый SQL-хелпер `exclude_marketplace()`, применённый во всех местах, отдающих товары для обычного обзора (каталог, поиск, ИИ-подбор, рекомендации); отдельная витрина — новый эндпоинт `GET /catalog/marketplace`, отбирающий строго по `source`.

**Tech Stack:** FastAPI + SQLAlchemy + PostgreSQL (backend), React + Vite + TypeScript (frontend/admin), pytest, vitest.

## Global Constraints

- Гарантия — 1 месяц (не переизобретать другую цифру нигде в текстах этой фичи).
- Никаких обещаний сроков рассмотрения заявки («в течение часа» и т.п.) — только факт: самовывоз в день обращения уже подтверждён, остальное не обещаем.
- `Product.condition` для товаров этого флоу — всегда `"used"`; качественное описание состояния (отличное/есть дефекты) — отдельное поле `metadata.state`, не `Product.condition`.
- `Маркетплейс` отбирается по `Product.source == "user_submitted"`, **не** по `condition == "used"` — эти два измерения независимы.
- Никакого AI/LLM в визарде подачи заявки.
- Никакого auto-publish: товар становится видимым только через ручное действие администратора (кнопка «Опубликовать в каталог» с формой на подтверждение, не «одобрить» одним тапом без просмотра).
- Rate-limit на подачу заявки и на загрузку фото — обязателен (см. Task 9).

---

## File Structure

**Backend — новое:**
- `backend/app/services/marketplace.py` — константа `MARKETPLACE_SOURCE` + хелпер `exclude_marketplace()`, единая точка изоляции.
- `backend/tests/test_marketplace.py` — сквозной тест изоляции.

**Backend — правки:**
- `backend/app/models/lead.py` — `"sell_item"` в `LEAD_TYPES`.
- `backend/app/models/product.py` — `condition` в `to_card()`.
- `backend/app/api/catalog.py` — исключение маркетплейса в 4 местах + новый `GET /catalog/marketplace`.
- `backend/app/services/catalog_nav.py` — исключение в `category_counts()`/`brand_counts()`.
- `backend/app/services/ai_retrieval.py` — исключение в 3 местах.
- `backend/app/services/recommendations.py` — исключение в пуле кандидатов.
- `backend/app/core/config.py` — 2 новых лимита.
- `backend/app/api/leads.py` — публичный upload-эндпоинт, rate-limit и уведомление модератору для `sell_item`.
- `backend/app/services/notification_templates.py` — `sell_item_message()`.

**Admin — правки:**
- `admin/src/ui.ts` — `LEAD_TYPE_RU`, `META_KEY_RU`.
- `admin/src/App.tsx` — `TYPE_PILL`, фото-галерея в деталях лида, кнопка «Опубликовать в каталог».
- `admin/src/HomeAdmin.tsx` — `ACTION_LABELS`.

**Frontend — новое:**
- `frontend/src/lib/sellItem.ts` + `frontend/src/lib/sellItem.test.ts` — чистая логика визарда.
- `frontend/src/pages/SellItem.tsx` — экран визарда, маршрут `/sell`.
- `frontend/src/pages/Marketplace.tsx` — экран витрины, маршрут `/marketplace`.

**Frontend — правки:**
- `frontend/src/lib/route.ts` — `actionRoute` кейсы `sell_item`/`marketplace`.
- `frontend/src/components/ProductCard.tsx` — бейдж «Б/у», серый вариант `Badge`.
- `frontend/src/pages/Home.tsx` — 4-я плитка в `QuickScenarios`, `ScenarioIcon` кейс `sell_item`.
- `frontend/src/App.tsx` — маршруты `/sell`, `/marketplace`.

---

## Task 1: Хелпер изоляции маркетплейса

**Files:**
- Create: `backend/app/services/marketplace.py`
- Test: `backend/tests/test_marketplace.py`

**Interfaces:**
- Produces: `MARKETPLACE_SOURCE: str = "user_submitted"`, `exclude_marketplace(stmt: Select) -> Select` — используется во всех задачах 4-7.

- [ ] **Step 1: Написать падающий тест**

```python
"""Изоляция «Маркетплейса»: пользовательские товары не смешиваются с обычным
каталогом (см. docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md)."""
from sqlalchemy import select

from app.models.product import Product
from app.services.marketplace import MARKETPLACE_SOURCE, exclude_marketplace
from tests.conftest import make_product


def test_exclude_marketplace_filters_by_source(db):
    regular = make_product(db, title="Обычный", source="manual")
    listed = make_product(db, title="С маркетплейса", source=MARKETPLACE_SOURCE)
    stmt = exclude_marketplace(select(Product))
    ids = {p.id for p in db.execute(stmt).scalars().all()}
    assert regular.id in ids
    assert listed.id not in ids


def test_exclude_marketplace_does_not_touch_used_condition_without_source(db):
    """condition="used" сам по себе НЕ маркетплейс — источник изоляции ТОЛЬКО source."""
    own_used_stock = make_product(db, title="Свой б/у", source="manual", condition="used")
    stmt = exclude_marketplace(select(Product))
    ids = {p.id for p in db.execute(stmt).scalars().all()}
    assert own_used_stock.id in ids
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd backend && python -m pytest tests/test_marketplace.py -v`
Expected: FAIL с `ModuleNotFoundError: No module named 'app.services.marketplace'`

- [ ] **Step 3: Написать реализацию**

```python
"""Изоляция «Маркетплейса» от обычного каталога.

Товары, которые пользователи предложили и магазин одобрил (см.
docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md), физически
живут в той же таблице products, но НЕ должны попадаться среди нового
ассортимента — в категориях, поиске, ИИ-подборе, секциях главной. Единая точка
исключения нужна, чтобы это правило не расползлось по десятку запросов и не
разъехалось (тот же класс бага, что уже был с захардкоженными категориями).

Разрез — ТОЛЬКО по source, не по condition: обычный б/у-товар магазина
(condition="used", source="manual") в «Маркетплейс» не входит и в обычном
каталоге остаётся как есть.
"""
from sqlalchemy import Select

from app.models.product import Product

MARKETPLACE_SOURCE = "user_submitted"


def exclude_marketplace(stmt: Select) -> Select:
    """Убрать из выдачи товары, предложенные пользователями через маркетплейс."""
    return stmt.where(Product.source != MARKETPLACE_SOURCE)
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `cd backend && python -m pytest tests/test_marketplace.py -v`
Expected: PASS (2 теста)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/marketplace.py backend/tests/test_marketplace.py
git commit -m "feat(маркетплейс): хелпер exclude_marketplace — единая точка изоляции от каталога"
```

---

## Task 2: `lead_type="sell_item"`

**Files:**
- Modify: `backend/app/models/lead.py:35`
- Test: `backend/tests/test_leads_sell_item.py`

**Interfaces:**
- Consumes: ничего нового.
- Produces: `LEAD_TYPES` включает `"sell_item"` — используется в Task 11 (create_lead) и Task 12-14 (admin).

- [ ] **Step 1: Написать падающий тест**

```python
"""Заявка «Предложить товар» (lead_type=sell_item) — см.
docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md."""
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_current_admin, get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User


@pytest.fixture()
def ctx(db):
    u = User(telegram_id=601, first_name="Настя", username="nastya")
    db.add(u)
    db.commit()
    db.refresh(u)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: db.get(User, u.id)
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        yield TestClient(app), db, u
    finally:
        app.dependency_overrides.clear()


def test_sell_item_lead_saved(ctx):
    client, db, _u = ctx
    payload = {
        "source": "home",
        "lead_type": "sell_item",
        "phone": "+79990000001",
        "metadata": {
            "category": "смартфоны", "title": "iPhone 13 Pro 128 ГБ",
            "state": "Хорошее, есть следы", "price_wanted": 45000,
            "photos": ["/api/uploads/a.jpg", "/api/uploads/b.jpg"],
        },
    }
    r = client.post("/api/leads", json=payload)
    assert r.status_code == 201
    body = r.json()
    assert body["lead_type"] == "sell_item"
    assert body["metadata"]["title"] == "iPhone 13 Pro 128 ГБ"
    assert body["metadata"]["photos"] == ["/api/uploads/a.jpg", "/api/uploads/b.jpg"]
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd backend && python -m pytest tests/test_leads_sell_item.py -v`
Expected: FAIL — `lead_type` нормализуется в `"general"` (не в `LEAD_TYPES` пока), `assert body["lead_type"] == "sell_item"` падает.

- [ ] **Step 3: Добавить значение в LEAD_TYPES**

`backend/app/models/lead.py:35`, было:
```python
LEAD_TYPES = ("general", "product", "trade_in", "b2b", "wholesale", "cart", "price_offer")
```
стало:
```python
# sell_item — «Предложить товар»: пользователь предлагает магазину свою б/у
# технику с фото и желаемой ценой (metadata.category/title/state/price_wanted/
# photos), после модерации становится товаром с source="user_submitted" в
# изолированном разделе «Маркетплейс» (см. services/marketplace.py).
LEAD_TYPES = ("general", "product", "trade_in", "b2b", "wholesale", "cart", "price_offer", "sell_item")
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `cd backend && python -m pytest tests/test_leads_sell_item.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/models/lead.py backend/tests/test_leads_sell_item.py
git commit -m "feat(заявки): lead_type=sell_item — заявка «Предложить товар»"
```

---

## Task 3: `condition` в `Product.to_card()`

**Files:**
- Modify: `backend/app/models/product.py:217` (внутри `to_card()`, перед `"why": []`)
- Test: `backend/tests/test_product_card.py`

**Interfaces:**
- Produces: `to_card()["condition"]` — потребляется фронтом в Task 17 (бейдж «Б/у»).

**Контекст:** сегодня `to_card()` НЕ включает `condition` в ответ (проверено чтением файла) — фронтовый тип `ProductCard.condition?` объявлен, но с бэкенда никогда не приходит. Бейдж не будет работать без этого шага.

- [ ] **Step 1: Написать падающий тест**

```python
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
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd backend && python -m pytest tests/test_product_card.py -v`
Expected: FAIL — `KeyError: 'condition'`

- [ ] **Step 3: Добавить поле**

`backend/app/models/product.py`, в `to_card()` (строка ~217, рядом с `"tags"`):
```python
            "tags": self.tags or [],
            # v5.9: бейдж «Б/у» на витрине — то же condition, что и в to_admin()/
            # to_detail(), просто раньше сюда не попадало.
            "condition": self.condition or "new",
            "why": [],
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `cd backend && python -m pytest tests/test_product_card.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/models/product.py backend/tests/test_product_card.py
git commit -m "feat(каталог): condition в to_card() — источник для бейджа «Б/у»"
```

---

## Task 4: Изоляция в `api/catalog.py`

**Files:**
- Modify: `backend/app/api/catalog.py:145` (`search_products`), `:210` (`list_catalog`), `:285` (`brands`), `:306` (`feed`)
- Test: `backend/tests/test_marketplace.py` (дополнить)

**Interfaces:**
- Consumes: `exclude_marketplace` из Task 1 (`from app.services.marketplace import exclude_marketplace`).

- [ ] **Step 1: Написать падающие тесты**

Добавить в `backend/tests/test_marketplace.py`:
```python
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User


def _client(db):
    def override_db():
        yield db

    def override_user():
        u = db.query(User).first()
        if u is None:
            u = User(telegram_id=701)
            db.add(u); db.commit(); db.refresh(u)
        return u

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    return TestClient(app)


def test_catalog_list_excludes_marketplace(db):
    make_product(db, title="Обычный смартфон", category="смартфоны", source="manual")
    make_product(db, title="Маркетплейс смартфон", category="смартфоны", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/list?category=смартфоны")
    titles = [c["title"] for c in r.json()["cards"]]
    assert "Обычный смартфон" in titles
    assert "Маркетплейс смартфон" not in titles
    app.dependency_overrides.clear()


def test_catalog_search_excludes_marketplace(db):
    make_product(db, title="iPhone 15 обычный", source="manual")
    make_product(db, title="iPhone 15 маркетплейс", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/search?query=iphone")
    titles = [c["title"] for c in r.json()["cards"]]
    assert "iPhone 15 обычный" in titles
    assert "iPhone 15 маркетплейс" not in titles
    app.dependency_overrides.clear()


def test_catalog_brands_excludes_marketplace(db):
    make_product(db, brand="Никогда-не-бренд", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/brands")
    assert "Никогда-не-бренд" not in r.json()["brands"]
    app.dependency_overrides.clear()


def test_catalog_feed_excludes_marketplace(db):
    make_product(db, title="Хит с маркетплейса", source=MARKETPLACE_SOURCE, is_hot=True)
    client = _client(db)
    r = client.get("/api/catalog/feed")
    titles = [c["title"] for c in r.json()["hot"]]
    assert "Хит с маркетплейса" not in titles
    app.dependency_overrides.clear()
```

- [ ] **Step 2: Запустить, убедиться что падают**

Run: `cd backend && python -m pytest tests/test_marketplace.py -v`
Expected: FAIL — 4 новых теста красные (маркетплейс-товары сейчас видны везде)

- [ ] **Step 3: Применить exclude_marketplace в 4 местах**

`backend/app/api/catalog.py`, добавить импорт (рядом со строкой 27-29):
```python
from app.services.catalog_nav import list_categories
from app.services.marketplace import exclude_marketplace
from app.services.ranking import default_order
```

`search_products()` (строка 145), было:
```python
    stmt = select(Product).where(Product.is_active.is_(True))
```
стало:
```python
    stmt = exclude_marketplace(select(Product).where(Product.is_active.is_(True)))
```

`list_catalog()` (строка 210), было:
```python
    stmt = select(Product).where(Product.is_active.is_(True))
```
стало:
```python
    stmt = exclude_marketplace(select(Product).where(Product.is_active.is_(True)))
```

`brands()` (строка 285), было:
```python
    rows = db.execute(
        select(Product.brand).where(Product.is_active.is_(True), Product.brand.is_not(None)).distinct()
    ).scalars().all()
```
стало:
```python
    rows = db.execute(
        exclude_marketplace(
            select(Product.brand).where(Product.is_active.is_(True), Product.brand.is_not(None))
        ).distinct()
    ).scalars().all()
```

`feed()` (строка 306), было:
```python
    base = select(Product).where(Product.is_active.is_(True))
```
стало:
```python
    base = exclude_marketplace(select(Product).where(Product.is_active.is_(True)))
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `cd backend && python -m pytest tests/test_marketplace.py -v`
Expected: PASS (6 тестов — 2 из Task 1 + 4 новых)

Затем прогнать полный набор регрессии каталога:
Run: `cd backend && python -m pytest tests/test_catalog*.py tests/test_ai_orchestrator.py -v`
Expected: PASS (обычные товары по умолчанию `source="manual"` в `make_product`, поведение существующих тестов не меняется)

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/catalog.py backend/tests/test_marketplace.py
git commit -m "feat(маркетплейс): исключить source=user_submitted из /catalog/list, /search, /brands, /feed"
```

---

## Task 5: Изоляция в `services/catalog_nav.py`

**Files:**
- Modify: `backend/app/services/catalog_nav.py:74-79` (`category_counts`), `:92-97` (`brand_counts`)
- Test: `backend/tests/test_catalog_nav.py` (дополнить)

**Interfaces:**
- Consumes: `exclude_marketplace` из Task 1.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `backend/tests/test_catalog_nav.py`:
```python
from app.services.marketplace import MARKETPLACE_SOURCE


def test_category_counts_excludes_marketplace(db):
    make_product(db, category="новая категория тест", source="manual")
    make_product(db, category="новая категория тест", source=MARKETPLACE_SOURCE)
    counts = category_counts(db)
    assert counts["новая категория тест"] == 1


def test_brand_counts_excludes_marketplace(db):
    make_product(db, brand="Тест-бренд-изоляция", source=MARKETPLACE_SOURCE)
    counts = brand_counts(db)
    assert "Тест-бренд-изоляция" not in counts
```

(добавить `category_counts, brand_counts` в существующий импорт из `app.services.catalog_nav` наверху файла)

- [ ] **Step 2: Запустить, убедиться что падают**

Run: `cd backend && python -m pytest tests/test_catalog_nav.py -v -k marketplace`
Expected: FAIL — счётчики включают маркетплейс-товары

- [ ] **Step 3: Применить exclude_marketplace**

`backend/app/services/catalog_nav.py`, добавить импорт наверху файла:
```python
from app.services.marketplace import exclude_marketplace
```

`category_counts()` (строка 74-79), было:
```python
    stmt = (
        select(Product.category, func.count())
        .where(Product.is_active.is_(True),
               Product.category.is_not(None), Product.category != "")
        .group_by(Product.category)
    )
```
стало:
```python
    stmt = exclude_marketplace(
        select(Product.category, func.count())
        .where(Product.is_active.is_(True),
               Product.category.is_not(None), Product.category != "")
        .group_by(Product.category)
    )
```

`brand_counts()` (строка 92-97), было:
```python
    rows = db.execute(
        select(Product.brand, func.count())
        .where(Product.is_active.is_(True),
               Product.brand.is_not(None), Product.brand != "")
        .group_by(Product.brand)
    ).all()
```
стало:
```python
    rows = db.execute(
        exclude_marketplace(
            select(Product.brand, func.count())
            .where(Product.is_active.is_(True),
                   Product.brand.is_not(None), Product.brand != "")
            .group_by(Product.brand)
        )
    ).all()
```

- [ ] **Step 4: Запустить, убедиться что проходят**

Run: `cd backend && python -m pytest tests/test_catalog_nav.py -v`
Expected: PASS (все, включая существующие)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/catalog_nav.py backend/tests/test_catalog_nav.py
git commit -m "feat(маркетплейс): исключить из счётчиков категорий/брендов на главной"
```

---

## Task 6: Изоляция в `services/ai_retrieval.py`

**Files:**
- Modify: `backend/app/services/ai_retrieval.py:257` (`_token_pool`), `:312` (`retrieve_candidates`), `:363` (neighbor-fallback)
- Test: `backend/tests/test_ai_retrieval.py` (дополнить)

**Interfaces:**
- Consumes: `exclude_marketplace` из Task 1.

- [ ] **Step 1: Написать падающий тест**

Добавить в `backend/tests/test_ai_retrieval.py`:
```python
from app.services.ai_retrieval import ExtractedFilters
from app.services.marketplace import MARKETPLACE_SOURCE


def test_retrieve_candidates_excludes_marketplace(db):
    make_product(db, title="iPhone 15 обычный", category="смартфоны", source="manual")
    make_product(db, title="iPhone 15 маркетплейс", category="смартфоны", source=MARKETPLACE_SOURCE)
    f = ExtractedFilters(category="смартфоны")
    candidates = retrieve_candidates(db, "iphone", f)
    titles = [p.title for p in candidates]
    assert "iPhone 15 обычный" in titles
    assert "iPhone 15 маркетплейс" not in titles
```

(добавить `retrieve_candidates` в импорт наверху файла, если его там ещё нет)

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd backend && python -m pytest tests/test_ai_retrieval.py -v -k marketplace`
Expected: FAIL

- [ ] **Step 3: Применить exclude_marketplace в 3 местах**

`backend/app/services/ai_retrieval.py`, добавить импорт наверху файла:
```python
from app.services.marketplace import exclude_marketplace
```

`_token_pool()` (строка 257), было:
```python
    stmt = select(Product).where(Product.is_active.is_(True), or_(*matches))
```
стало:
```python
    stmt = exclude_marketplace(select(Product).where(Product.is_active.is_(True), or_(*matches)))
```

`retrieve_candidates()` структурная ветка (строка 312), было:
```python
    stmt = select(Product).where(Product.is_active.is_(True))
```
стало:
```python
    stmt = exclude_marketplace(select(Product).where(Product.is_active.is_(True)))
```

Neighbor-fallback (строка 363), было:
```python
        alt = select(Product).where(Product.is_active.is_(True)).where(or_(
```
стало:
```python
        alt = exclude_marketplace(select(Product).where(Product.is_active.is_(True))).where(or_(
```

Также `search_products()`, вызываемая отсюда как `by_words` (строка 308), уже исключает маркетплейс — правится в Task 4 (тот же файл `catalog.py`, общая функция).

- [ ] **Step 4: Запустить, убедиться что проходит**

Run: `cd backend && python -m pytest tests/test_ai_retrieval.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/ai_retrieval.py backend/tests/test_ai_retrieval.py
git commit -m "feat(маркетплейс): исключить из кандидатов ИИ-подбора"
```

---

## Task 7: Изоляция в `services/recommendations.py`

**Files:**
- Modify: `backend/app/services/recommendations.py:237-239`
- Test: `backend/tests/test_recommendations.py` (дополнить)

**Interfaces:**
- Consumes: `exclude_marketplace` из Task 1.

- [ ] **Step 1: Написать падающий тест**

Прочитать начало `backend/tests/test_recommendations.py`, чтобы использовать тот же импорт функции (вероятно `recommend` или аналог, вызывающий этот пул). Добавить:
```python
from app.services.marketplace import MARKETPLACE_SOURCE


def test_recommend_excludes_marketplace(db):
    make_product(db, title="Обычный для вас", source="manual")
    marketplace_item = make_product(db, title="С маркетплейса для вас", source=MARKETPLACE_SOURCE)
    result = recommend(db, user_id=1)
    ids = {p.id for p in result.items} if hasattr(result, "items") else {p.id for p in result}
    assert marketplace_item.id not in ids
```

Примечание для реализующего: сверить фактическую сигнатуру `recommend()`/тип возврата по уже существующим тестам в этом файле (выше по файлу) — сигнатура здесь ориентировочная по коду `recommendations.py:225-254`, но дополнительный shape (`.items` или сразу список) нужно скопировать из соседнего работающего теста в этом же файле.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd backend && python -m pytest tests/test_recommendations.py -v -k marketplace`
Expected: FAIL

- [ ] **Step 3: Применить exclude_marketplace**

`backend/app/services/recommendations.py`, добавить импорт наверху файла:
```python
from app.services.marketplace import exclude_marketplace
```

Строка 237-239, было:
```python
    candidates = db.execute(
        select(Product).where(Product.is_active.is_(True))
    ).scalars().all()
```
стало:
```python
    candidates = db.execute(
        exclude_marketplace(select(Product).where(Product.is_active.is_(True)))
    ).scalars().all()
```

- [ ] **Step 4: Запустить, убедиться что проходит**

Run: `cd backend && python -m pytest tests/test_recommendations.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/recommendations.py backend/tests/test_recommendations.py
git commit -m "feat(маркетплейс): исключить из пула персональных рекомендаций"
```

---

## Task 8: `GET /catalog/marketplace`

**Files:**
- Modify: `backend/app/api/catalog.py` (новый роут, после `feed()`)
- Test: `backend/tests/test_marketplace.py` (дополнить)

**Interfaces:**
- Consumes: `MARKETPLACE_SOURCE` (Task 1), `default_order` (уже импортирован в файле), `_photo_last`, `apply_group_images`, `apply_social_proof` (уже используются в файле).
- Produces: `GET /catalog/marketplace` → `{"cards": [...]}"` — потребляется фронтом в Task 22 (`Marketplace.tsx`).

- [ ] **Step 1: Написать падающий тест**

Добавить в `backend/tests/test_marketplace.py`:
```python
def test_marketplace_endpoint_returns_only_user_submitted(db):
    make_product(db, title="Обычный", source="manual")
    listed = make_product(db, title="С маркетплейса", source=MARKETPLACE_SOURCE)
    client = _client(db)
    r = client.get("/api/catalog/marketplace")
    assert r.status_code == 200
    titles = [c["title"] for c in r.json()["cards"]]
    assert titles == ["С маркетплейса"]
    app.dependency_overrides.clear()


def test_marketplace_endpoint_deterministic_order(db):
    """Тот же принцип, что test_order_is_fully_deterministic у обычного каталога:
    id в конце ключа сортировки обязателен."""
    make_product(db, title="A", source=MARKETPLACE_SOURCE, price=1000)
    make_product(db, title="B", source=MARKETPLACE_SOURCE, price=1000)
    client = _client(db)
    r1 = client.get("/api/catalog/marketplace")
    r2 = client.get("/api/catalog/marketplace")
    assert [c["id"] for c in r1.json()["cards"]] == [c["id"] for c in r2.json()["cards"]]
    app.dependency_overrides.clear()
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd backend && python -m pytest tests/test_marketplace.py -v -k marketplace_endpoint`
Expected: FAIL — `404 Not Found`

- [ ] **Step 3: Добавить эндпоинт**

`backend/app/api/catalog.py`, после `feed()` (перед закрывающим блоком функции или в конец файла модуля — после её `return`):
```python
@router.get("/marketplace", dependencies=[Depends(get_current_user)])
def marketplace(limit: int = Query(default=50, ge=1, le=100), db: Session = Depends(get_db)):
    """Витрина «Маркетплейс» — товары, предложенные и одобренные пользователями.

    Строго по source, а не по condition (см. services/marketplace.py) —
    обычный б/у-сток магазина сюда не попадает. Сортировка та же, что у
    обычного каталога (default_order) — своей позиции плитки у этих товаров
    нет, они естественно уходят по NO_TILE_RANK, что здесь не имеет значения:
    список не смешивается с товарами, у которых плитка есть.
    """
    from app.services.marketplace import MARKETPLACE_SOURCE
    stmt = (
        select(Product)
        .where(Product.is_active.is_(True), Product.source == MARKETPLACE_SOURCE)
        .order_by(*default_order(db))
        .limit(limit)
    )
    products = list(db.execute(stmt).scalars().all())
    products = _photo_last(db, products)
    cards = [p.to_card() for p in products]
    apply_group_images(db, products, cards)
    apply_social_proof(db, products, cards)
    return {"cards": cards}
```

- [ ] **Step 4: Запустить, убедиться что проходит**

Run: `cd backend && python -m pytest tests/test_marketplace.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/catalog.py backend/tests/test_marketplace.py
git commit -m "feat(маркетплейс): GET /catalog/marketplace — витрина пользовательских товаров"
```

---

## Task 9: Лимиты в конфиге

**Files:**
- Modify: `backend/app/core/config.py` (рядом с `AI_CHAT_DAILY_LIMIT_PER_USER`, строка ~135)

**Interfaces:**
- Produces: `settings.SELL_ITEM_DAILY_LIMIT_PER_USER`, `settings.SELL_ITEM_UPLOAD_DAILY_LIMIT_PER_USER` — потребляются в Task 10, 11.

Без отдельного TDD-цикла: чистая конфигурация, поведение проверяется тестами Task 10/11.

- [ ] **Step 1: Добавить поля**

`backend/app/core/config.py`, рядом со строкой `AI_CHAT_DAILY_LIMIT_PER_USER: int = 50`:
```python
    # Заявка «Предложить товар» — фото делают спам дороже для нас (диск), чем
    # обычный текстовый лид, поэтому свой (не AI) дневной потолок.
    SELL_ITEM_DAILY_LIMIT_PER_USER: int = 5
    # Отдельно от лимита заявок: один визард — до 10 фото, несколько
    # незавершённых попыток укладываются с запасом.
    SELL_ITEM_UPLOAD_DAILY_LIMIT_PER_USER: int = 40
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/core/config.py
git commit -m "feat(маркетплейс): лимиты подачи заявки и загрузки фото"
```

---

## Task 10: Публичный upload-эндпоинт для фото

**Files:**
- Modify: `backend/app/api/leads.py`
- Test: `backend/tests/test_leads_sell_item.py` (дополнить)

**Interfaces:**
- Consumes: `save_image`, `is_allowed`, `MAX_BYTES` из `app.core.uploads` (уже существуют); `check_rate_limit` из `app.core.rate_limit`; `client_ip` из `app.api.deps`.
- Produces: `POST /api/leads/uploads/marketplace-photo` → `{"url": str}` — потребляется фронтом в Task 19 (визард).

- [ ] **Step 1: Написать падающие тесты**

Добавить в `backend/tests/test_leads_sell_item.py`:
```python
import io


def test_upload_marketplace_photo(ctx):
    client, _db, _u = ctx
    r = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("photo.jpg", io.BytesIO(b"\xff\xd8\xff" + b"0" * 100), "image/jpeg")},
    )
    assert r.status_code == 201
    assert r.json()["url"].startswith("/api/uploads/")


def test_upload_marketplace_photo_rejects_bad_type(ctx):
    client, _db, _u = ctx
    r = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("file.txt", io.BytesIO(b"not an image"), "text/plain")},
    )
    assert r.status_code == 400


def test_upload_marketplace_photo_rate_limited(ctx, monkeypatch):
    client, _db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.SELL_ITEM_UPLOAD_DAILY_LIMIT_PER_USER", 1)
    ok = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("photo.jpg", io.BytesIO(b"\xff\xd8\xff" + b"0" * 100), "image/jpeg")},
    )
    assert ok.status_code == 201
    blocked = client.post(
        "/api/leads/uploads/marketplace-photo",
        files={"file": ("photo.jpg", io.BytesIO(b"\xff\xd8\xff" + b"0" * 100), "image/jpeg")},
    )
    assert blocked.status_code == 429
```

- [ ] **Step 2: Запустить, убедиться что падают**

Run: `cd backend && python -m pytest tests/test_leads_sell_item.py -v -k upload`
Expected: FAIL — `404 Not Found`

- [ ] **Step 3: Добавить эндпоинт**

`backend/app/api/leads.py`, добавить в импорты наверху файла:
```python
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status

from app.api.deps import client_ip, get_current_user
from app.core.rate_limit import check_rate_limit
from app.core.uploads import MAX_BYTES, is_allowed, save_image
```

(объединить с уже существующими импортами `from fastapi import ...` и `from app.api.deps import get_current_user` — не дублировать)

В конец файла, после `my_leads()`:
```python
@router.post("/uploads/marketplace-photo", status_code=status.HTTP_201_CREATED)
async def upload_marketplace_photo(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Фото для заявки «Предложить товар» — публичная (не admin) загрузка.

    Те же ограничения размера/типа, что у admin-загрузки (core/uploads.py), но
    свой дневной лимит на пользователя: без него загрузка фото — самый дешёвый
    способ забить диск, дешевле даже спам-заявок (см. Task 9)."""
    rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
    if not check_rate_limit(
        f"sell_item_upload:{rl_key}",
        limit=settings.SELL_ITEM_UPLOAD_DAILY_LIMIT_PER_USER,
        window_seconds=86400,
    ):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много фото за сегодня")
    if not is_allowed(file.content_type):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Только изображения: jpg, png, webp, gif")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл больше 8 МБ")
    return {"url": save_image(file.content_type, data)}
```

- [ ] **Step 4: Запустить, убедиться что проходят**

Run: `cd backend && python -m pytest tests/test_leads_sell_item.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/leads.py backend/tests/test_leads_sell_item.py
git commit -m "feat(маркетплейс): публичная загрузка фото для заявки «Предложить товар»"
```

---

## Task 11: Rate-limit и уведомление модератору для `sell_item`

**Files:**
- Modify: `backend/app/api/leads.py` (`create_lead`)
- Modify: `backend/app/services/notification_templates.py`
- Test: `backend/tests/test_leads_sell_item.py` (дополнить)

**Interfaces:**
- Consumes: `settings.SELL_ITEM_DAILY_LIMIT_PER_USER` (Task 9), `settings.ADMIN_TELEGRAM_ID`, `notifications.enqueue` (уже используются в `_notify_owner`).
- Produces: `sell_item_message(...)` — Message для уведомления.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `backend/tests/test_leads_sell_item.py`:
```python
from app.models.notification import Notification  # тот же импорт, что у существующего теста price_offer


def test_sell_item_notifies_admin(ctx, monkeypatch):
    client, db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.ADMIN_TELEGRAM_ID", "999")
    payload = {
        "source": "home", "lead_type": "sell_item", "phone": "+79990000002",
        "metadata": {"category": "смартфоны", "title": "iPhone 12", "price_wanted": 30000,
                      "photos": ["/api/uploads/a.jpg"]},
    }
    r = client.post("/api/leads", json=payload)
    assert r.status_code == 201
    notif = db.query(Notification).filter_by(kind="sell_item").first()
    assert notif is not None
    assert "iPhone 12" in notif.text


def test_sell_item_rate_limited(ctx, monkeypatch):
    client, _db, _u = ctx
    monkeypatch.setattr("app.core.config.settings.SELL_ITEM_DAILY_LIMIT_PER_USER", 1)
    payload = {
        "source": "home", "lead_type": "sell_item", "phone": "+79990000003",
        "metadata": {"category": "смартфоны", "title": "iPhone X", "price_wanted": 10000},
    }
    ok = client.post("/api/leads", json=payload)
    assert ok.status_code == 201
    blocked = client.post("/api/leads", json=payload)
    assert blocked.status_code == 429
```

(поле называется `text`, не `message` — `Notification.text` хранит содержимое, `enqueue()` принимает параметр `message: Message | None` и сам кладёт его `.text` в колонку; `kind` — свободная строка, `NOTIFICATION_KINDS` в `models/notification.py` ничем не валидируется на вставке, `"price_offer"` уже используется в обход этого списка, тот же принцип годится для `"sell_item"`)

- [ ] **Step 2: Запустить, убедиться что падают**

Run: `cd backend && python -m pytest tests/test_leads_sell_item.py -v -k "notifies or rate_limited"`
Expected: FAIL — уведомление не создаётся, rate-limit не проверяется

- [ ] **Step 3: Добавить шаблон уведомления**

`backend/app/services/notification_templates.py`, рядом с `price_offer_message`:
```python
def sell_item_message(*, title: str, price_wanted, phone: str | None, username: str | None) -> Message:
    """Новая заявка «Предложить товар» — алерт модератору в «Заявки»."""
    who = f"@{username}" if username else "покупатель"
    lines = [
        "🏷️ <b>Новая заявка: предложили товар</b>",
        "",
        f"<b>{_esc(title)}</b>",
        f"Желаемая цена: {format_money(price_wanted) or '—'}",
        f"От: {who}" + (f", {_esc(phone)}" if phone else ""),
        "",
        "Смотрите фото и детали в «Заявках» админки.",
    ]
    return Message(text="\n".join(lines))
```

(сверить с сигнатурой/типом `Message` и функцией `format_money`/`_esc`, уже используемыми в `price_offer_message` — скопировать их применение 1:1)

- [ ] **Step 4: Добавить rate-limit и вызов уведомления в create_lead**

`backend/app/api/leads.py`, в начало `create_lead()` (после сигнатуры, до текущей логики):
```python
@router.post("", status_code=status.HTTP_201_CREATED)
def create_lead(
    body: LeadIn, request: Request,
    user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    lead_type = body.lead_type or DEFAULT_LEAD_TYPE
    if lead_type == "sell_item":
        rl_key = f"user:{user.id}" if getattr(user, "id", None) else f"ip:{client_ip(request)}"
        if not check_rate_limit(
            f"sell_item:{rl_key}",
            limit=settings.SELL_ITEM_DAILY_LIMIT_PER_USER,
            window_seconds=86400,
        ):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много заявок за сегодня")
    # Название и цену товара берём из БД (не доверяем клиенту), если передан product_id.
```

(строка `lead_type = body.lead_type or DEFAULT_LEAD_TYPE` уже существует чуть ниже в функции — убрать дубль, оставить только это новое вычисление в начале и использовать его дальше по функции; добавить параметр `request: Request` в сигнатуру, импортировать `Request` из `fastapi`)

Вызов уведомления — рядом с существующим блоком `if lead_type == PRICE_OFFER_TYPE:` (после `db.add(lead)`):
```python
    db.add(lead)
    if lead_type == PRICE_OFFER_TYPE:
        db.flush()
        _notify_owner(db, lead, meta)
    elif lead_type == "sell_item":
        db.flush()
        _notify_sell_item(db, lead, meta)
    db.commit()
```

Функция `_notify_sell_item`, рядом с `_notify_owner`:
```python
def _notify_sell_item(db: Session, lead: Lead, meta: dict) -> None:
    """Алерт модератору о новой заявке «Предложить товар» — та же схема, что
    _notify_owner для price_offer: без сети, той же транзакцией."""
    if not settings.ADMIN_TELEGRAM_ID:
        return
    from app.services.notification_templates import sell_item_message
    from app.services.notifications import enqueue

    try:
        chat_id = int(settings.ADMIN_TELEGRAM_ID)
    except (TypeError, ValueError):
        logger.warning("ADMIN_TELEGRAM_ID не число — уведомление о sell_item пропущено")
        return

    enqueue(
        db, chat_id=chat_id, kind="sell_item",
        message=sell_item_message(
            title=str(meta.get("title") or "товар"),
            price_wanted=meta.get("price_wanted"),
            phone=lead.phone, username=lead.username,
        ),
        dedupe_key=f"sell_item:{lead.id}",
    )
```

- [ ] **Step 5: Запустить, убедиться что проходят**

Run: `cd backend && python -m pytest tests/test_leads_sell_item.py -v`
Expected: PASS

Затем прогнать регрессию всей заявочной части:
Run: `cd backend && python -m pytest tests/test_leads_scenario.py tests/test_leads_sell_item.py -v`
Expected: PASS (существующие типы лидов не затронуты)

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/leads.py backend/app/services/notification_templates.py backend/tests/test_leads_sell_item.py
git commit -m "feat(маркетплейс): rate-limit заявки + уведомление модератору о sell_item"
```

---

## Task 12: Admin — лейблы `sell_item`

**Files:**
- Modify: `admin/src/ui.ts:183-186` (`LEAD_TYPE_RU`), рядом (`META_KEY_RU`, строка ~237-250)
- Modify: `admin/src/App.tsx:305-311` (`TYPE_PILL`)

Чистые словарные правки, без TDD-цикла — проверяются вручную в Task 13 (галерея) и общим regression-прогоном `npx tsc --noEmit`.

- [ ] **Step 1: `LEAD_TYPE_RU`**

`admin/src/ui.ts:183-186`, было:
```typescript
export const LEAD_TYPE_RU: Record<string, string> = {
  general: "Обычная", product: "Товар", trade_in: "Trade-In", b2b: "Для бизнеса",
  wholesale: "Опт", cart: "Корзина", price_offer: "Нашли дешевле",
};
```
стало:
```typescript
export const LEAD_TYPE_RU: Record<string, string> = {
  general: "Обычная", product: "Товар", trade_in: "Trade-In", b2b: "Для бизнеса",
  wholesale: "Опт", cart: "Корзина", price_offer: "Нашли дешевле",
  sell_item: "Предложение товара",
};
```

- [ ] **Step 2: `META_KEY_RU`**

`admin/src/ui.ts:237-250`, добавить в объект (рядом с `category: "Категория"`):
```typescript
  category: "Категория", budget: "Бюджет",
  title: "Название", state: "Состояние", price_wanted: "Желаемая цена",
```

`price_wanted` — сумма в рублях, добавить в `META_MONEY_KEYS` (строка 253):
```typescript
const META_MONEY_KEYS = new Set(["promo_discount", "subtotal", "price_wanted"]);
```

`photos` намеренно НЕ добавляется в `META_KEY_RU` — Task 13 рендерит его отдельным блоком-галереей, а не текстовой строкой через `leadMetaRows`; чтобы `leadMetaRows` не показал его ещё и как склеенный список URL, добавить в `META_HIDDEN` (строка 254):
```typescript
const META_HIDDEN = new Set(["origin", "photos"]);
```

- [ ] **Step 3: `TYPE_PILL`**

`admin/src/App.tsx:305-311`, было:
```typescript
const TYPE_PILL: Record<string, { bg: string; fg: string }> = {
  general: { bg: C.muted, fg: C.sub },
  product: { bg: "#e3f2fd", fg: C.accentDark },
  trade_in: { bg: "#eafaf0", fg: "#0e9f6e" },
  b2b: { bg: "#eef0ff", fg: "#5b5bd6" },
  wholesale: { bg: "#fff3d6", fg: "#b57e00" },
};
```
стало:
```typescript
const TYPE_PILL: Record<string, { bg: string; fg: string }> = {
  general: { bg: C.muted, fg: C.sub },
  product: { bg: "#e3f2fd", fg: C.accentDark },
  trade_in: { bg: "#eafaf0", fg: "#0e9f6e" },
  b2b: { bg: "#eef0ff", fg: "#5b5bd6" },
  wholesale: { bg: "#fff3d6", fg: "#b57e00" },
  sell_item: { bg: "#fdf2e9", fg: "#c2570c" },
};
```

- [ ] **Step 4: Проверить типы**

Run: `cd admin && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 5: Commit**

```bash
git add admin/src/ui.ts admin/src/App.tsx
git commit -m "feat(админка): лейблы для лида sell_item"
```

---

## Task 13: Admin — фото-галерея в деталях лида

**Files:**
- Modify: `admin/src/App.tsx` (внутри деталей лида, рядом со строками 621-630)

**Interfaces:**
- Consumes: `lead.metadata.photos: string[]` (Task 2/11), `lead.lead_type === "sell_item"`.

- [ ] **Step 1: Добавить рендер галереи**

`admin/src/App.tsx`, сразу после блока `leadMetaRows` (строки 621-630), добавить:
```tsx
            {/* ---- Фото заявки «Предложить товар» ---- */}
            {lead.lead_type === "sell_item" &&
              Array.isArray((lead.metadata as Record<string, unknown> | undefined)?.photos) &&
              ((lead.metadata as Record<string, unknown>).photos as string[]).length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
                {((lead.metadata as Record<string, unknown>).photos as string[]).map((url, i) => (
                  <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={url} alt={`Фото ${i + 1}`}
                      style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.border}` }}
                    />
                  </a>
                ))}
              </div>
            )}
```

(`C.border` — свериться с реальным именем токена рамки в объекте `C` наверху `App.tsx`; если называется иначе, например `C.line`, использовать реальное имя)

- [ ] **Step 2: Проверить типы и собрать**

Run: `cd admin && npx tsc --noEmit && npm run build`
Expected: без ошибок

- [ ] **Step 3: Ручная проверка**

Открыть админку локально (`docker-compose.demo.yml`, `admin` на 5174), создать через API тестовую заявку `lead_type=sell_item` с `metadata.photos`, убедиться, что миниатюры рендерятся и открываются по клику в новой вкладке.

- [ ] **Step 4: Commit**

```bash
git add admin/src/App.tsx
git commit -m "feat(админка): галерея фото в деталях заявки «Предложить товар»"
```

---

## Task 14: Admin — «Опубликовать в каталог»

**Files:**
- Modify: `backend/app/api/admin_crm.py:357-365` (`_PRODUCT_EDITABLE`)
- Test: `backend/tests/test_admin_products.py` (дополнить, если файл существует — иначе создать рядом с уже существующими admin-тестами товаров)
- Modify: `admin/src/App.tsx` (действия менеджера, рядом со строками 632-639; импорт `apiPost` в строке 3)

**Контекст (важно, найдено при подготовке плана — НЕ то, что предполагалось в спеке):** в админке **нет** отдельного роута/страницы создания товара — есть `ProductModal` внутри `admin/src/Products.tsx`, открывается локальным состоянием (`setCreating(true)` в `Products`), и при создании (`isNew`) эта форма СОЗНАТЕЛЬНО не даёт прикрепить фото («Сначала создайте товар — затем откройте его и добавьте фото», `Products.tsx:654-656`) — она рассчитана на ручной файловый аплоад, а не на готовые URL. Пробрасывать выбор вкладки + предзаполненный черновик из `App.tsx` (заявки) в `Products.tsx` (товары) через общий стейт — отдельная, более рискованная переделка двух независимых сегодня компонентов.

Бэкенд же (`POST /admin/products`, `admin_crm.py:396-406` → `_apply_product_fields`) принимает `images` (список URL) НАПРЯМУЮ в теле запроса при создании — ограничение только в этой конкретной форме UI, не в API. Поэтому кнопка на лиде делает **прямой** `POST /admin/products` (тот же `apiPost`, что уже использует `Products.tsx`), без открытия модалки-редактора. Ревью происходит ДО клика — модератор уже видит все поля и галерею фото лида (Task 13) на этом же экране; поправить что-то после создания можно обычным «Изменить» в товарах (уже существует, не меняется).

**Отдельная находка:** `_PRODUCT_EDITABLE` (`admin_crm.py:357-365`) — белый список полей, которые `POST/PATCH /admin/products` вообще принимает — **не включает `source`**. Без этого шага `source="user_submitted"` в теле запроса будет молча проигнорирован (`_apply_product_fields` копирует только поля из этого списка), и трассируемость происхождения товара потеряется.

**Interfaces:**
- Consumes: `apiPost<T>(path, token, body)` из `admin/src/ui.ts:113` (уже используется в `Products.tsx`).

- [ ] **Step 1: Написать падающий backend-тест**

```python
"""_PRODUCT_EDITABLE должен принимать source — иначе он молча теряется при
создании товара из заявки «Предложить товар» (см. Task 14 плана)."""
from app.models.product import Product


def test_admin_create_product_accepts_source(db):
    from fastapi.testclient import TestClient
    from app.api.deps import get_current_admin
    from app.db.session import get_db
    from app.main import app

    def override_db():
        yield db
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin] = lambda: "admin@test.local"
    try:
        client = TestClient(app)
        r = client.post("/api/admin/products", json={
            "title": "iPhone 13 из заявки", "price": 45000,
            "category": "смартфоны", "condition": "used",
            "images": ["/api/uploads/a.jpg"], "source": "user_submitted",
        })
        assert r.status_code == 201
        created = db.query(Product).filter_by(title="iPhone 13 из заявки").one()
        assert created.source == "user_submitted"
        assert created.images == ["/api/uploads/a.jpg"]
    finally:
        app.dependency_overrides.clear()
```

(сверить точный префикс роута — `/api/admin/products` или без `/api`, и способ авторизации админского клиента — по образцу уже существующих admin-тестов товаров в `backend/tests/`, если такой файл найдётся; если своего файла для admin-товаров ещё нет, создать `backend/tests/test_admin_products_source.py` с этим тестом)

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd backend && python -m pytest tests/test_admin_products_source.py -v`
Expected: FAIL — `created.source == "manual"` (дефолт), не `"user_submitted"`

- [ ] **Step 3: Добавить `source` в `_PRODUCT_EDITABLE`**

`backend/app/api/admin_crm.py:357-365`, было:
```python
_PRODUCT_EDITABLE = (
    "sku", "title", "brand", "category", "subcategory", "price", "old_price", "stock", "in_stock",
    "is_active", "is_hot", "is_available_today", "is_new", "on_sale",
    "is_limited",   # v5.5.0: показывать «Осталось N шт» на витрине
    "is_legendary",  # v5.8: закрепить наверху выдачи и пометить золотом
    "availability_mode",  # Cart: пусто = вывести из in_stock/is_limited
    "warranty_months", "condition", "color", "memory", "storage", "screen_size", "cpu", "ram",
    "description", "specs", "tags", "image", "images", "url",
    "poster_url",   # v5.8: афиша события для страницы легендарного товара
```
стало (добавить `"source"` в список, рядом с `"condition"` — та же строка):
```python
    "warranty_months", "condition", "color", "memory", "storage", "screen_size", "cpu", "ram",
    "description", "specs", "tags", "image", "images", "url", "source",
    # source редактируемо намеренно: admin-кнопка «Опубликовать в каталог»
    # (см. заявку sell_item) проставляет "user_submitted" при создании — без
    # этого поля в белом списке значение молча терялось бы.
    "poster_url",
```

- [ ] **Step 4: Запустить, убедиться что проходит**

Run: `cd backend && python -m pytest tests/test_admin_products_source.py -v`
Expected: PASS

Прогнать регрессию создания/редактирования товаров:
Run: `cd backend && python -m pytest tests/ -v -k admin_product`
Expected: PASS (существующие сценарии создания без `source` в теле не меняют поведение — поле просто не тронется, дефолт `"manual"` из модели остаётся)

- [ ] **Step 5: Commit (backend)**

```bash
git add backend/app/api/admin_crm.py backend/tests/test_admin_products_source.py
git commit -m "fix(админка): source — редактируемое поле товара, иначе теряется при публикации из заявки"
```

- [ ] **Step 6: Добавить кнопку и прямой POST на фронте**

`admin/src/App.tsx:3`, было:
```typescript
  C, card, input, btn, btnGhost, chip, apiGet, apiPatch, fmtPrice, fmtDateTime, storefrontUrl,
```
стало:
```typescript
  C, card, input, btn, btnGhost, chip, apiGet, apiPatch, apiPost, fmtPrice, fmtDateTime, storefrontUrl,
```

В блоке «Действия менеджера» (рядом со строкой 632), добавить перед существующим select статуса — потребуется локальный state для индикации отправки и сообщения об ошибке (добавить `useState` рядом с остальными в компоненте деталей лида):
```tsx
            {lead.lead_type === "sell_item" && lead.status !== "cancelled" && lead.status !== "completed" && (
              <button
                style={btn}
                disabled={publishing}
                onClick={async () => {
                  const meta = (lead.metadata as Record<string, unknown>) || {};
                  const photos = Array.isArray(meta.photos) ? (meta.photos as string[]) : [];
                  setPublishing(true);
                  try {
                    await apiPost("/admin/products", token, {
                      title: String(meta.title || lead.product_title || "Товар из заявки"),
                      price: Number(meta.price_wanted) || 0,
                      category: String(meta.category || ""),
                      condition: "used",
                      description: lead.message || "",
                      images: photos,
                      source: "user_submitted",
                    });
                    await patch({ status: "completed" });
                  } catch (e) {
                    setPublishError(e instanceof Error ? e.message : "Не удалось опубликовать товар");
                  } finally {
                    setPublishing(false);
                  }
                }}
              >
                {publishing ? "Публикуем…" : "Опубликовать в каталог"}
              </button>
            )}
            {publishError && <p style={{ color: C.red, fontSize: 13 }}>{publishError}</p>}
```

(`patch({ status: "completed" })` — переиспользует уже существующую функцию смены статуса лида, видную в этом же компоненте по вызову `patch({ status: e.target.value })` чуть ниже; `publishing`/`publishError` — новые `useState<boolean>(false)`/`useState<string | null>(null)` рядом с остальным state компонента деталей лида; `token` уже есть в скоупе — проп компонента `Leads`)

- [ ] **Step 7: Проверить типы и собрать**

Run: `cd admin && npx tsc --noEmit && npm run build`
Expected: без ошибок

- [ ] **Step 8: Ручная проверка**

Открыть заявку `sell_item` в статусе `new` (все поля и фото уже видны на этом экране — Task 13), нажать «Опубликовать в каталог» — убедиться, что товар создаётся с `source="user_submitted"`, `condition="used"`, фото из заявки, а статус лида автоматически становится `completed`. Открыть созданный товар через обычное «Изменить» в «Товарах» — поправить при необходимости (это и есть постпубликационное редактирование, отдельного экрана для него не заводим).

- [ ] **Step 9: Commit (frontend)**

```bash
git add admin/src/App.tsx
git commit -m "feat(админка): кнопка «Опубликовать в каталог» на заявке sell_item — прямой POST /admin/products"
```

---

## Task 15: Admin — `ACTION_LABELS`

**Files:**
- Modify: `admin/src/HomeAdmin.tsx:392-395`

**Interfaces:**
- Consumes: ничего нового.
- Produces: `action_type` варианты `sell_item`/`marketplace`, доступные в выпадающем списке для баннеров И тайлов (общий `ACTION_LABELS`) — потребляется фронтом в Task 16 (`route.ts`).

- [ ] **Step 1: Добавить значения**

`admin/src/HomeAdmin.tsx:392-395`, было:
```typescript
const ACTION_LABELS: Record<string, string> = {
  category: "Категория", brand: "Бренд", search: "Поиск", product: "Товар (id)",
  collection: "Подборка (hot/today/sale)", ai: "AI-запрос", external: "Внешняя ссылка",
};
```
стало:
```typescript
const ACTION_LABELS: Record<string, string> = {
  category: "Категория", brand: "Бренд", search: "Поиск", product: "Товар (id)",
  collection: "Подборка (hot/today/sale)", ai: "AI-запрос", external: "Внешняя ссылка",
  sell_item: "Предложить товар (подать заявку)", marketplace: "Маркетплейс (витрина)",
};
```

- [ ] **Step 2: Проверить типы**

Run: `cd admin && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Commit**

```bash
git add admin/src/HomeAdmin.tsx
git commit -m "feat(админка): action_type sell_item/marketplace для баннеров и тайлов"
```

---

## Task 16: `actionRoute` — `sell_item`/`marketplace`

**Files:**
- Modify: `frontend/src/lib/route.ts:33-46`
- Test: `frontend/src/lib/route.test.ts` (создать, если не существует — проверить `frontend/src/lib/` на файл `route.test.ts`; если существует, дополнить)

**Interfaces:**
- Produces: `actionRoute("sell_item", ...) === "/sell"`, `actionRoute("marketplace", ...) === "/marketplace"` — потребляется Task 20 (баннер/тайл на главной уже используют `actionRoute` через `HeroBanner`/`HomeCat`, изменений в местах вызова не требуется).

- [ ] **Step 1: Написать падающий тест**

```typescript
import { describe, expect, it } from "vitest";
import { actionRoute } from "./route";

describe("actionRoute sell_item/marketplace", () => {
  it("sell_item ведёт на визард подачи заявки", () => {
    expect(actionRoute("sell_item")).toBe("/sell");
  });

  it("marketplace ведёт на витрину", () => {
    expect(actionRoute("marketplace")).toBe("/marketplace");
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd frontend && npx vitest run route.test.ts`
Expected: FAIL — оба возвращают дефолт `/catalog`

- [ ] **Step 3: Добавить кейсы**

`frontend/src/lib/route.ts:33-46`, было:
```typescript
    case "ai": return v ? `/ai?q=${encodeURIComponent(v)}` : "/ai";
    default: return "/catalog";
```
стало:
```typescript
    case "ai": return v ? `/ai?q=${encodeURIComponent(v)}` : "/ai";
    // sell_item — подать заявку «Предложить товар»; marketplace — витрина
    // уже одобренных пользовательских товаров (два разных места, см.
    // docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md).
    case "sell_item": return "/sell";
    case "marketplace": return "/marketplace";
    default: return "/catalog";
```

- [ ] **Step 4: Запустить, убедиться что проходит**

Run: `cd frontend && npx vitest run route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/route.ts frontend/src/lib/route.test.ts
git commit -m "feat(маршруты): actionRoute — sell_item → /sell, marketplace → /marketplace"
```

---

## Task 17: Бейдж «Б/у» на карточке товара

**Files:**
- Modify: `frontend/src/components/ProductCard.tsx:335-352` (`Badge`), `:488-494` (использование в карточке)
- Modify: `frontend/src/components/ai/types.ts` (тип `ProductCard.condition` уже объявлен — проверить, не требуется правка)

**Interfaces:**
- Consumes: `card.condition` (Task 3, уже приходит из `to_card()`).

Визуальная правка без backend-логики — TDD здесь не применим так же прямо; проверка через `npm run build` + ручной просмотр в браузере (шаг 3).

- [ ] **Step 1: Добавить серый вариант в `Badge`**

`frontend/src/components/ProductCard.tsx:335-346`, было:
```typescript
export function Badge({ color, children }: {
  color: "red" | "blue" | "green" | "orange" | "gold"; children: ReactNode;
}) {
  const map = {
    red: "bg-danger text-white",
    blue: "bg-accent text-white",
    green: "bg-green text-white",
    orange: "bg-orange text-white",
    gold: "bg-[#2b1c00] text-[#ffce6a]",
  };
```
стало:
```typescript
export function Badge({ color, children }: {
  color: "red" | "blue" | "green" | "orange" | "gold" | "gray"; children: ReactNode;
}) {
  const map = {
    red: "bg-danger text-white",
    blue: "bg-accent text-white",
    green: "bg-green text-white",
    orange: "bg-orange text-white",
    gold: "bg-[#2b1c00] text-[#ffce6a]",
    // «Б/у» — нейтральная информация о товаре, не промо-сигнал вроде «Хит»/
    // скидки/легендарного: подложка нарочно спокойная, не соревнуется с ними.
    gray: "bg-mutedbg text-muted",
  };
```

- [ ] **Step 2: Показать бейдж на карточке**

`frontend/src/components/ProductCard.tsx:488-494`, было:
```tsx
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col items-start gap-1">
          {card.is_legendary && <Badge color="gold">Легендарный</Badge>}
          {card.is_hot && <Badge color="orange"><Icon name="flame" className="h-3 w-3" strokeWidth={2.2} />Хит</Badge>}
          {disc && <Badge color="red">−{disc}%</Badge>}
        </div>
```
стало:
```tsx
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col items-start gap-1">
          {card.is_legendary && <Badge color="gold">Легендарный</Badge>}
          {card.is_hot && <Badge color="orange"><Icon name="flame" className="h-3 w-3" strokeWidth={2.2} />Хит</Badge>}
          {disc && <Badge color="red">−{disc}%</Badge>}
          {card.condition === "used" && <Badge color="gray">Б/у</Badge>}
        </div>
```

- [ ] **Step 3: Проверить типы и собрать**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: без ошибок

- [ ] **Step 4: Ручная проверка в браузере**

Запустить дев-стенд (`docker-compose.demo.yml`), открыть `/catalog`, временно проставить в БД одному товару `condition="used"` (или дождаться Task 22, когда появятся реальные маркетплейс-товары) — убедиться, что серый бейдж «Б/у» отображается в левом верхнем углу карточки, не перекрывает другие бейджи и остаётся читаемым.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ProductCard.tsx
git commit -m "feat(витрина): бейдж «Б/у» на карточке товара"
```

---

## Task 18: `lib/sellItem.ts` — логика визарда

**Files:**
- Create: `frontend/src/lib/sellItem.ts`
- Create: `frontend/src/lib/sellItem.test.ts`

**Interfaces:**
- Produces: тип `SellItemValues`, функции `validateSellItemField(key, values)`, `buildSellItemLead(values, photos, phone)`, константа `SELL_ITEM_STEPS` — потребляются Task 19 (`SellItem.tsx`).

- [ ] **Step 1: Написать падающие тесты**

```typescript
import { describe, expect, it } from "vitest";
import { buildSellItemLead, validateSellItem, type SellItemValues } from "./sellItem";

const FULL: SellItemValues = {
  category: "смартфоны", title: "iPhone 13 Pro 128 ГБ",
  state: "Хорошее, есть следы", price: "45000", comment: "Полный комплект",
};

describe("buildSellItemLead", () => {
  it("собирает тело заявки из значений формы", () => {
    const body = buildSellItemLead(FULL, ["/api/uploads/a.jpg", "/api/uploads/b.jpg"], "+79990000000");
    expect(body).toEqual({
      source: "home",
      lead_type: "sell_item",
      phone: "+79990000000",
      message: "Полный комплект",
      metadata: {
        category: "смартфоны", title: "iPhone 13 Pro 128 ГБ",
        state: "Хорошее, есть следы", price_wanted: 45000,
        photos: ["/api/uploads/a.jpg", "/api/uploads/b.jpg"],
      },
    });
  });

  it("комментарий необязателен — message становится null", () => {
    const body = buildSellItemLead({ ...FULL, comment: "" }, ["/api/uploads/a.jpg"], "+79990000000");
    expect(body.message).toBeNull();
  });
});

describe("validateSellItem", () => {
  it("требует категорию, название, цену, минимум одно фото и телефон", () => {
    expect(validateSellItem(FULL, [], "")).toBe("Оставьте телефон — иначе не сможем связаться");
    expect(validateSellItem(FULL, ["/api/uploads/a.jpg"], "")).toBe("Оставьте телефон — иначе не сможем связаться");
    expect(validateSellItem(FULL, [], "+79990000000")).toBe("Добавьте хотя бы одно фото");
    expect(validateSellItem({ ...FULL, price: "0" }, ["/api/uploads/a.jpg"], "+79990000000")).toBe("Укажите цену больше нуля");
    expect(validateSellItem({ ...FULL, title: "" }, ["/api/uploads/a.jpg"], "+79990000000")).toBe("Укажите, что за товар");
    expect(validateSellItem(FULL, ["/api/uploads/a.jpg"], "+79990000000")).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падают**

Run: `cd frontend && npx vitest run sellItem.test.ts`
Expected: FAIL — `Cannot find module './sellItem'`

- [ ] **Step 3: Написать реализацию**

```typescript
/** Логика визарда «Предложить товар» — чистые функции, без DOM. Шаги: категория
 *  → название → состояние → цена → фото → телефон → комментарий → превью.
 *  Стейт-машина здесь примитивная (линейный список шагов, не граф синонимов, как
 *  у scenarioChat) — визард без AI-эскалации, каждое поле принимается как есть.
 */
export type SellItemValues = {
  category: string;
  title: string;
  state: string;
  price: string;
  comment: string;
};

export const SELL_ITEM_STEPS = ["category", "title", "state", "price", "photos", "phone", "comment", "preview"] as const;
export type SellItemStep = (typeof SELL_ITEM_STEPS)[number];

export type SellItemLeadBody = {
  source: string;
  lead_type: "sell_item";
  phone: string | null;
  message: string | null;
  metadata: {
    category: string;
    title: string;
    state: string;
    price_wanted: number;
    photos: string[];
  };
};

/** Собрать тело POST /leads. Комментарий — единственное free-text поле,
 *  уходит в message (как textarea у обычных сценариев), остальное — metadata. */
export function buildSellItemLead(
  values: SellItemValues, photos: string[], phone: string,
): SellItemLeadBody {
  return {
    source: "home",
    lead_type: "sell_item",
    phone: phone.trim() || null,
    message: values.comment.trim() || null,
    metadata: {
      category: values.category,
      title: values.title.trim(),
      state: values.state,
      price_wanted: Number(values.price),
      photos,
    },
  };
}

/** Проверка перед отправкой. Возвращает текст ошибки или null. */
export function validateSellItem(
  values: SellItemValues, photos: string[], phone: string,
): string | null {
  if (!values.category.trim()) return "Выберите категорию";
  if (!values.title.trim()) return "Укажите, что за товар";
  const price = Number(values.price);
  if (!values.price.trim() || !Number.isFinite(price) || price <= 0) {
    return "Укажите цену больше нуля";
  }
  if (photos.length === 0) return "Добавьте хотя бы одно фото";
  if (!phone.trim()) return "Оставьте телефон — иначе не сможем связаться";
  return null;
}
```

- [ ] **Step 4: Запустить, убедиться что проходят**

Run: `cd frontend && npx vitest run sellItem.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/sellItem.ts frontend/src/lib/sellItem.test.ts
git commit -m "feat(маркетплейс): чистая логика визарда «Предложить товар»"
```

---

## Task 19: `pages/SellItem.tsx` — экран визарда

**Files:**
- Create: `frontend/src/pages/SellItem.tsx`
- Modify: `frontend/src/App.tsx:98` (добавить маршрут `/sell`)

**Interfaces:**
- Consumes: `SellItemValues`, `SELL_ITEM_STEPS`, `buildSellItemLead`, `validateSellItem` (Task 18); `POST /api/leads` и `POST /api/leads/uploads/marketplace-photo` через `api()` (Task 10, 11); `list_categories` — эквивалент на фронте: переиспользовать существующий способ получения категорий, которым уже пользуется `Catalog.tsx` (`GET /catalog/categories`, см. `frontend/src/pages/Home.tsx:254`).

Без изолированного TDD-цикла на уровне компонента (страница целиком, а не чистая функция) — логика уже покрыта тестами `sellItem.ts` (Task 18), здесь — сборка UI и ручная проверка в браузере (Step 4).

**Важно (найдено при подготовке плана):** `api()` из `frontend/src/lib/api.ts:38-45` жёстко ставит `Content-Type: application/json` на КАЖДЫЙ запрос — для загрузки файла (`FormData`) это ломает multipart-boundary, который обязан выставить сам браузер. В приложении (в отличие от `admin/src/ui.ts`, где `apiUpload` уже существует) такого файлового варианта нет — нужно добавить.

- [ ] **Step 1: Добавить `apiUploadFile` в `lib/api.ts`**

`frontend/src/lib/api.ts`, добавить рядом с `export async function api<T>`:
```typescript
/** Загрузка файла (multipart), тот же 401-retry, что у api(). Content-Type
 *  НЕ ставим явно — fetch сам выставит boundary; наш JSON-заголовок в
 *  rawRequest() его бы сломал, поэтому здесь свой минимальный fetch. */
export async function apiUploadFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const doFetch = () => {
    const { accessToken } = useAuthStore.getState();
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    return fetch(`${BASE}${path}`, { method: "POST", headers, body: form });
  };
  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(errorText(body, res.status), res.status);
  }
  return res.json();
}
```

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок (использует уже существующие в файле `tryRefresh`, `BASE`, `ApiError`, `errorText`, `useAuthStore` — новых импортов не требует)

- [ ] **Step 2: Написать компонент**

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiUploadFile } from "../lib/api";
import { track } from "../lib/analytics";
import { toast } from "../lib/toast";
import {
  buildSellItemLead, validateSellItem, type SellItemValues,
} from "../lib/sellItem";
import { ProductImage } from "../components/ProductCard";
import { formatPrice } from "../lib/format";

const STATE_OPTIONS = ["Отличное", "Хорошее, есть следы", "Есть дефекты"];
const MAX_PHOTOS = 10;

type Category = { key: string; label: string };

export default function SellItem() {
  const navigate = useNavigate();
  const [categories, setCategories] = useState<Category[]>([]);
  const [values, setValues] = useState<SellItemValues>({
    category: "", title: "", state: "", price: "", comment: "",
  });
  const [photos, setPhotos] = useState<string[]>([]);
  const [phone, setPhone] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ categories: Category[] }>("/catalog/categories")
      .then((d) => setCategories(d.categories))
      .catch(() => {});
  }, []);

  function set<K extends keyof SellItemValues>(key: K, v: SellItemValues[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function onFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = MAX_PHOTOS - photos.length;
    const toUpload = Array.from(files).slice(0, remaining);
    setUploading(true);
    try {
      for (const file of toUpload) {
        const { url } = await apiUploadFile<{ url: string }>("/leads/uploads/marketplace-photo", file);
        setPhotos((prev) => [...prev, url]);
      }
    } catch {
      toast("Не удалось загрузить фото", "error");
    } finally {
      setUploading(false);
    }
  }

  function removePhoto(url: string) {
    setPhotos((prev) => prev.filter((p) => p !== url));
  }

  async function submit() {
    const validationError = validateSellItem(values, photos, phone);
    if (validationError) { setError(validationError); return; }
    setError(null);
    setSubmitting(true);
    try {
      await api("/leads", { method: "POST", body: JSON.stringify(buildSellItemLead(values, photos, phone)) });
      track("sell_item_submitted", { category: values.category });
      setDone(true);
    } catch {
      toast("Не удалось отправить заявку, попробуйте ещё раз", "error");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg font-bold">Заявка отправлена</p>
        <p className="text-sm text-muted">
          Заявку рассмотрит модератор. Если всё ок, свяжемся по телефону, чтобы забрать товар —
          самовывоз или согласуем удобный способ.
        </p>
        <button className="tap rounded-field bg-accent px-5 py-3 text-sm font-semibold text-white"
          onClick={() => navigate("/requests")}>
          Посмотреть заявку
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md p-4 pb-28">
      <h1 className="text-xl font-bold">Предложить товар</h1>
      <p className="mt-1 text-sm text-muted">
        Расскажите о товаре, добавьте фото — окончательную цену магазин подтвердит при осмотре.
      </p>

      <label className="mt-5 block text-sm font-semibold">Категория</label>
      <div className="mt-2 flex flex-wrap gap-2">
        {categories.map((c) => (
          <button key={c.key} type="button"
            onClick={() => set("category", c.key)}
            className={`tap rounded-full px-3 py-1.5 text-sm font-medium ${
              values.category === c.key ? "bg-accent text-white" : "bg-mutedbg text-text"
            }`}>
            {c.label}
          </button>
        ))}
      </div>

      <label className="mt-5 block text-sm font-semibold">Что за товар</label>
      <input className="mt-2 w-full rounded-field border border-black/10 px-3 py-2.5 text-sm"
        placeholder="Например, iPhone 13 Pro 128 ГБ"
        value={values.title} onChange={(e) => set("title", e.target.value)} />

      <label className="mt-5 block text-sm font-semibold">Состояние</label>
      <div className="mt-2 flex flex-wrap gap-2">
        {STATE_OPTIONS.map((s) => (
          <button key={s} type="button" onClick={() => set("state", s)}
            className={`tap rounded-full px-3 py-1.5 text-sm font-medium ${
              values.state === s ? "bg-accent text-white" : "bg-mutedbg text-text"
            }`}>
            {s}
          </button>
        ))}
      </div>

      <label className="mt-5 block text-sm font-semibold">Желаемая цена</label>
      <input className="mt-2 w-full rounded-field border border-black/10 px-3 py-2.5 text-sm"
        type="number" inputMode="numeric" placeholder="Например, 45000"
        value={values.price} onChange={(e) => set("price", e.target.value)} />

      <label className="mt-5 block text-sm font-semibold">Фото ({photos.length}/{MAX_PHOTOS})</label>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {photos.map((url) => (
          <div key={url} className="relative aspect-square overflow-hidden rounded-field">
            <ProductImage src={url} title="Фото товара" />
            <button type="button" onClick={() => removePhoto(url)}
              className="tap absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white">
              ✕
            </button>
          </div>
        ))}
        {photos.length < MAX_PHOTOS && (
          <label className="tap flex aspect-square cursor-pointer items-center justify-center rounded-field border-2 border-dashed border-black/15 text-sm text-muted">
            {uploading ? "…" : "+"}
            <input type="file" accept="image/*" multiple className="hidden" disabled={uploading}
              onChange={(e) => onFilesSelected(e.target.files)} />
          </label>
        )}
      </div>

      <label className="mt-5 block text-sm font-semibold">Телефон</label>
      <input className="mt-2 w-full rounded-field border border-black/10 px-3 py-2.5 text-sm"
        type="tel" placeholder="+7 900 000-00-00"
        value={phone} onChange={(e) => setPhone(e.target.value)} />

      <label className="mt-5 block text-sm font-semibold">Комментарий (необязательно)</label>
      <textarea className="mt-2 w-full rounded-field border border-black/10 px-3 py-2.5 text-sm"
        rows={3} value={values.comment} onChange={(e) => set("comment", e.target.value)} />

      {values.title && values.price && (
        <div className="mt-6 rounded-xl2 bg-surface p-3 shadow-card">
          <p className="text-xs font-semibold uppercase text-muted">Превью карточки</p>
          <div className="mt-2 flex gap-3">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-field">
              <ProductImage src={photos[0]} title={values.title} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{values.title}</p>
              <p className="text-sm font-bold">{formatPrice(Number(values.price) || 0)}</p>
              <span className="mt-1 inline-block rounded-full bg-mutedbg px-2 py-0.5 text-[11px] font-semibold text-muted">
                На модерации
              </span>
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <button type="button" disabled={submitting} onClick={submit}
        className="tap mt-6 w-full rounded-field bg-accent py-3 text-sm font-semibold text-white disabled:opacity-60">
        {submitting ? "Отправляем…" : "Отправить на модерацию"}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Зарегистрировать маршрут**

`frontend/src/App.tsx:98`, было:
```tsx
          <Route path="/apply/:scenario" element={<DeferredPage><ScenarioChat /></DeferredPage>} />
```
стало (добавить строкой ниже):
```tsx
          <Route path="/apply/:scenario" element={<DeferredPage><ScenarioChat /></DeferredPage>} />
          <Route path="/sell" element={<DeferredPage><SellItem /></DeferredPage>} />
```
и добавить импорт `SellItem` рядом с остальными `lazy`/`import` объявлениями страниц наверху `App.tsx` (сверить точный паттерн импорта — обычный `import` или `React.lazy`, как у соседних страниц, и повторить тот же).

- [ ] **Step 4: Проверить типы и собрать**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: без ошибок

- [ ] **Step 5: Ручная проверка в браузере**

Запустить дев-стенд, открыть `/sell`, пройти весь визард: выбрать категорию, ввести название, состояние, цену, загрузить 1-2 фото, ввести телефон, проверить превью карточки, отправить — убедиться, что заявка появляется в `/requests` и в админке под типом «Предложение товара» с фото-галереей (Task 13).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/pages/SellItem.tsx frontend/src/App.tsx
git commit -m "feat(маркетплейс): экран визарда «Предложить товар» (/sell)"
```

---

## Task 20: 4-я плитка «Продать» в `QuickScenarios`

**Files:**
- Modify: `frontend/src/pages/Home.tsx:947-963` (`ScenarioIcon`), `:986-1035` (`QuickScenarios`)

**Interfaces:**
- Consumes: `useNavigate()` (уже доступен в `Home.tsx`).

Визуальная/навигационная правка — TDD не применим напрямую, проверка через ручной просмотр (Step 4).

- [ ] **Step 1: Добавить иконку**

`frontend/src/pages/Home.tsx:958-961`, было:
```tsx
      case "wholesale":
        return <><path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>;
      default: // нейтральный силуэт для незнакомого сценария
```
стало:
```tsx
      case "wholesale":
        return <><path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>;
      case "sell_item":  // ценник-бирка
        return <><path d="M11 3h6a2 2 0 0 1 2 2v6L10 20l-9-9L10 3z" /><circle cx="15" cy="8" r="1.4" /></>;
      default: // нейтральный силуэт для незнакомого сценария
```

- [ ] **Step 2: Переверстать `QuickScenarios` в 2×2 с 4-м пунктом**

`frontend/src/pages/Home.tsx:986-1017`, было (сигнатура и items-массив):
```tsx
function QuickScenarios({
  onCatalog, onScenario, onMacbook,
}: {
  onCatalog: (route: string, scenario: string) => void;
  onScenario: (k: ScenarioKey) => void;
  onMacbook: () => void;
}) {
  const items: { key: string; label: string; detail: string; onClick: () => void }[] = [
    { key: "tradein", label: "Trade-In", detail: "Оценим технику", onClick: () => onScenario("trade_in") },
    { key: "b2b", label: "Бизнесу", detail: "Счёт юрлицу", onClick: () => onScenario("b2b") },
    { key: "wholesale", label: "Опт", detail: "Цена на партию", onClick: () => onScenario("wholesale") },
```
стало:
```tsx
function QuickScenarios({
  onCatalog, onScenario, onMacbook, onSellItem,
}: {
  onCatalog: (route: string, scenario: string) => void;
  onScenario: (k: ScenarioKey) => void;
  onMacbook: () => void;
  onSellItem: () => void;
}) {
  // Группировка 2×2 не произвольная: Trade-In и Продать — «у меня есть
  // техника», Бизнесу и Опт — «нужна техника для бизнеса» (см. спеку). Detail
  // «Фото и своя цена» намеренно не повторяет «Оценим технику» у Trade-In —
  // Trade-In сегодня это лид без фото/цены (звонит менеджер, каталог не
  // пополняется), sell_item — цена и фото от пользователя, после модерации
  // становится настоящей карточкой. Разница должна читаться из подписи, а не
  // угадываться после клика.
  const items: { key: string; label: string; detail: string; onClick: () => void }[] = [
    { key: "tradein", label: "Trade-In", detail: "Оценим технику", onClick: () => onScenario("trade_in") },
    { key: "sell_item", label: "Продать", detail: "Фото и своя цена", onClick: onSellItem },
    { key: "b2b", label: "Бизнесу", detail: "Счёт юрлицу", onClick: () => onScenario("b2b") },
    { key: "wholesale", label: "Опт", detail: "Цена на партию", onClick: () => onScenario("wholesale") },
```

Ниже в этой же функции — заменить сетку с `grid-cols-3` на `grid-cols-2` (строка ~1017):
было:
```tsx
    <div className="stagger mt-4 grid grid-cols-3 gap-2 lg:hidden">
```
стало:
```tsx
    <div className="stagger mt-4 grid grid-cols-2 gap-2 lg:hidden">
```

- [ ] **Step 3: Передать `onSellItem` в месте вызова `QuickScenarios`**

`frontend/src/pages/Home.tsx:490-496` (место вызова), было:
```tsx
      <QuickScenarios
        onCatalog={(route) => {
          navigate(safeInternalRoute(route));
        }}
        onScenario={openScenario}
        onMacbook={openMacbook}
      />
```
стало:
```tsx
      <QuickScenarios
        onCatalog={(route) => {
          navigate(safeInternalRoute(route));
        }}
        onScenario={openScenario}
        onMacbook={openMacbook}
        onSellItem={() => { track("quick_scenario_clicked", { scenario: "sell_item" }); navigate("/sell"); }}
      />
```

- [ ] **Step 4: Проверить типы, собрать, проверить в браузере**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: без ошибок

Открыть `/` (главную) в дев-стенде на mobile-ширине — убедиться, что плитки собрались в сетку 2×2 (Trade-In/Продать сверху, Бизнесу/Опт снизу), подписи не обрезаются, тап по «Продать» ведёт на `/sell`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Home.tsx
git commit -m "feat(главная): плитка «Продать» в QuickScenarios, сетка 2×2"
```

---

## Task 21: `pages/Marketplace.tsx` — витрина

**Files:**
- Create: `frontend/src/pages/Marketplace.tsx`
- Modify: `frontend/src/App.tsx` (маршрут `/marketplace`)

**Interfaces:**
- Consumes: `GET /catalog/marketplace` (Task 8), существующий `ProductCard` компонент (default export из `frontend/src/components/ProductCard.tsx`).

- [ ] **Step 1: Написать компонент**

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import ProductCard from "../components/ProductCard";
import type { ProductCard as TCard } from "../components/ai/types";

export default function Marketplace() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<TCard[] | null>(null);

  useEffect(() => {
    api<{ cards: TCard[] }>("/catalog/marketplace")
      .then((d) => setCards(d.cards))
      .catch(() => setCards([]));
  }, []);

  return (
    <div className="mx-auto max-w-md p-4 pb-28">
      <h1 className="text-xl font-bold">Маркетплейс</h1>
      <p className="mt-1 text-sm text-muted">Б/у техника от пользователей, проверенная магазином.</p>

      <button type="button" onClick={() => navigate("/sell")}
        className="tap mt-4 flex w-full items-center gap-3 rounded-xl2 bg-surface p-4 text-left shadow-card">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
          +
        </span>
        <span>
          <span className="block text-sm font-bold">Есть что продать?</span>
          <span className="block text-xs text-muted">Предложить товар</span>
        </span>
      </button>

      {cards === null && <p className="mt-6 text-sm text-muted">Загружаем…</p>}
      {cards !== null && cards.length === 0 && (
        <p className="mt-6 text-sm text-muted">Пока здесь пусто — станьте первым, кто предложит товар.</p>
      )}
      {cards !== null && cards.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3">
          {cards.map((c) => <ProductCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}
```

Примечание для реализующего: сверить точный экспорт `ProductCard` (`export default memo(ProductCard)` подтверждён чтением файла) и точное имя типа `ProductCard` в `components/ai/types.ts` (может конфликтовать по имени с самим компонентом — при необходимости импортировать с алиасом, как уже сделано в `ProductCard.tsx` самом: `import { ProductCard as TCard } from "./ai/types"`).

- [ ] **Step 2: Зарегистрировать маршрут**

`frontend/src/App.tsx`, рядом со строкой, добавленной в Task 19:
```tsx
          <Route path="/sell" element={<DeferredPage><SellItem /></DeferredPage>} />
          <Route path="/marketplace" element={<DeferredPage><Marketplace /></DeferredPage>} />
```
и добавить импорт `Marketplace` тем же способом, что и `SellItem` в Task 19.

- [ ] **Step 3: Проверить типы и собрать**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: без ошибок

- [ ] **Step 4: Ручная проверка в браузере**

Опубликовать через админку (Task 14) один товар из тестовой заявки `sell_item`, открыть `/marketplace` в дев-стенде — убедиться, что товар отображается с бейджем «Б/у» (Task 17), карточка кликабельна и ведёт на обычную страницу товара, а в обычном `/catalog` этот же товар не появляется (ручная проверка изоляции поверх backend-тестов Task 4-7).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Marketplace.tsx frontend/src/App.tsx
git commit -m "feat(маркетплейс): экран витрины (/marketplace)"
```

---

## Task 22: Сквозная регрессия

**Files:**
- Test only, без правок кода.

- [ ] **Step 1: Полный backend-прогон**

Run: `cd backend && python -m pytest -q`
Expected: все тесты зелёные (774+ существующих + новые из Task 1-11)

- [ ] **Step 2: Полный frontend-прогон**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: без ошибок

- [ ] **Step 3: Полный admin-прогон**

Run: `cd admin && npx tsc --noEmit && npm run build`
Expected: без ошибок

- [ ] **Step 4: Ручной сквозной прогон в браузере**

1. `/sell` → заполнить визард → отправить → увидеть «Заявка отправлена».
2. Админка → «Заявки» → найти заявку типа «Предложение товара», увидеть фото-галерею.
3. Нажать «Опубликовать в каталог», сохранить товар.
4. Убедиться: товар появился в `/marketplace` с бейджем «Б/у», НЕ появился в `/catalog` по своей категории, НЕ появился в результатах `/ai`-поиска по названию.
5. Проверить баннер и плитку «Продать» на главной — обе ведут на `/sell`.

- [ ] **Step 5: Финальный commit (если были поправки по итогам регрессии)**

```bash
git add -A
git commit -m "fix(маркетплейс): правки по итогам сквозной регрессии"
```

(коммитить только если реально были правки — пустой коммит не создавать)
