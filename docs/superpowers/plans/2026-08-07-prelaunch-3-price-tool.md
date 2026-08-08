# PreLaunch Patch, фаза 3: инструмент цен

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обновление цен по прайсу поставщика перестаёт быть ручной операцией через SQL: владелец вставляет прайс, видит сопоставление с нашим каталогом, правит спорное и применяет — с телефона.

**Architecture:** Логика сопоставления переезжает из одноразового скрипта в `backend/app/services/price_match.py` и накрывается тестами на реальных ловушках, которые уже выстрелили. Поверх — эндпоинт «разобрать прайс → вернуть предложение» (ничего не меняет) и «применить выбранное» (меняет). Интерфейс — новый раздел админки, свёрстанный от телефона. DEXA сюда подключается позже как ещё один источник прайса: контракт `parse → match → preview → apply` от источника не зависит.

**Tech Stack:** FastAPI + SQLAlchemy, pytest, React/Vite (admin).

---

## Почему это надо делать как продукт, а не скриптом

07.08.2026 цены обновляли вручную скриптом. Автосопоставление дало **четыре класса ошибок**, каждая из которых поставила бы неверную цену на живой товар:

| ловушка | что произошло | цена уехала бы |
|---|---|---|
| Общее слово в бренде | «apple» проверялся раньше «iphone/macbook/ipad», и всё Apple схлопывалось в Vision Pro | +300% |
| Квалификатор модели | MacBook **Air** сматчился с MacBook **Pro** | +90% |
| Объём памяти | iPad 256 ГБ сматчился с 1 ТБ; у нас объём лежит в отдельной колонке, а в тексте идёт без единиц («256»), поэтому regex по названию его не видел | +60% |
| Поколение чипа | iPad M5 сматчился с M4 | −20% |
| Год как цена | Строки-заголовки «iPad Pro 13 M5 2025» и штамп даты «08/08/2026» разбирались как товар ценой 2025 ₽ и 2026 ₽ | −98% |

Пятая ловушка живёт в наших же данных: у товара 32 в названии опечатка «шум**у**оподавлением», из-за неё он не сматчился с правильным «с шумоподавлением» и притянул цену обычной модели без ANC.

**Вывод для реализации:** каждая из этих ловушек обязана стать тестом. Пороговые «уверенно / проверить / не найдено» — не украшение, а единственная причина, по которой ошибки заметили до применения.

Исходники разбора и сопоставления лежат в scratchpad этой сессии (`parse_full.py`, `match.py`) — их надо перенести в репозиторий, а не переписывать с нуля.

---

## Task 1: Перенести разбор прайса в проект

**Files:**
- Create: `backend/app/services/price_parse.py`
- Create: `backend/tests/test_price_parse.py`

- [ ] **Step 1: Тесты на реальные ловушки разбора**

Create `backend/tests/test_price_parse.py`:

```python
from app.services.price_parse import parse_price_lines


def test_parses_plain_line():
    items = parse_price_lines(["iPhone 17 Pro 256 Black — 104.000"])
    assert items[0].name == "iPhone 17 Pro 256 Black"
    assert items[0].price == 104000


def test_parses_price_without_separators():
    items = parse_price_lines(["Honor 400 8/256 Black 27900"])
    assert items[0].price == 27900


def test_skips_date_stamp():
    """«08/08/2026» — штамп даты прайса, а не товар за 2026 ₽.

    На живом прайсе это дало 60+ фальшивых позиций.
    """
    assert parse_price_lines(["08/08/2026"]) == []


def test_skips_model_year_heading():
    """«iPad Pro 13 M5 2025» — заголовок раздела, а не цена 2025 ₽."""
    assert parse_price_lines(["iPad Pro 13 M5 2025"]) == []


def test_keeps_year_like_price_after_explicit_separator():
    """А вот «Кабель — 2025» с явным разделителем цена и есть."""
    items = parse_price_lines(["Кабель USB-C — 2025"])
    assert items and items[0].price == 2025


def test_strips_flags_and_emoji_from_name():
    items = parse_price_lines(["🇭🇰📸Dyson HD16 Blue Copper -28.000"])
    assert items[0].name == "Dyson HD16 Blue Copper"
    assert items[0].region == "🇭🇰"


def test_marks_on_request():
    items = parse_price_lines(["Nintendo switch 2 Mario - 🚗"])
    assert items[0].price is None
    assert "on_request" in items[0].flags
```

- [ ] **Step 2: Убедиться, что падают**

Run: `cd backend && python -m pytest tests/test_price_parse.py -v`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализовать**

Перенеси логику из `parse_full.py` (scratchpad сессии 07.08.2026) в `backend/app/services/price_parse.py`. Обязательно сохрани:

- дата-класс позиции с полями `name`, `price`, `region`, `flags`, `raw`;
- пропуск строк-шумов (гарантия, «получите», «заказать», артикулы);
- **защиту от года-как-цены**: голое 4-значное число в диапазоне 2015–2030 без явного разделителя перед ним — не цена;
- пропуск строки, целиком состоящей из даты `dd/mm/yyyy`;
- распознавание «🚗» как «цена по запросу».

Функция принимает список строк (не HTML) — источник (Telegram-экспорт, вставка из буфера, файл) её не касается.

- [ ] **Step 4: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_price_parse.py -v`
Expected: 7 passed

- [ ] **Step 5: Коммит**

```bash
git add backend/app/services/price_parse.py backend/tests/test_price_parse.py
git commit -m "feat(цены): разбор прайса поставщика с защитой от года-как-цены"
```

---

## Task 2: Сопоставление с каталогом

**Files:**
- Create: `backend/app/services/price_match.py`
- Create: `backend/tests/test_price_match.py`

- [ ] **Step 1: Тесты на все четыре ловушки**

Create `backend/tests/test_price_match.py`:

```python
from app.services.price_match import match_offer, MatchTier


def _p(**kw):
    """Минимальный товар каталога для сопоставления."""
    base = dict(id=1, brand="", title="", storage=None, memory=None)
    base.update(kw)
    return base


def test_matches_same_model_confidently():
    m = match_offer(
        _p(brand="Apple", title="MacBook Pro 14 M5 Max 18/32 36GB 2TB Silver"),
        [{"name": "MGDQ4 MacBook Pro 14 M5 Max 18/32 36GB 2TB Silver", "price": 320000}],
    )
    assert m.tier == MatchTier.HIGH
    assert m.price == 320000


def test_air_never_matches_pro():
    """MacBook Air и MacBook Pro совпадают по чипу, памяти и цвету.

    На живых данных это дало +90% к цене.
    """
    m = match_offer(
        _p(brand="Apple", title="MacBook Air 13 M5 16/1Tb Silver"),
        [{"name": "MGDN4 MacBook Pro 14 M5 Pro 15/16 24GB 1TB Silver", "price": 210000}],
    )
    assert m.tier is not MatchTier.HIGH


def test_storage_must_agree():
    """256 ГБ против 1 ТБ: у нас объём в отдельной колонке и без единиц."""
    m = match_offer(
        _p(brand="Apple", title="iPad Pro 13 M5 256 Black Wi-Fi", storage="256 ГБ"),
        [{"name": "iPad Pro 13 m5 1TB Black Wi-Fi", "price": 147500}],
    )
    assert m.tier is not MatchTier.HIGH


def test_chip_generation_must_agree():
    m = match_offer(
        _p(brand="Apple", title="iPad Pro 11 M5 512 Black LTE", storage="512 ГБ"),
        [{"name": "iPad Pro 11 (M4) 512 LTE Black", "price": 98000}],
    )
    assert m.tier is not MatchTier.HIGH


def test_generic_brand_word_does_not_swallow_everything():
    """«apple» есть в названии почти любого нашего товара Apple."""
    m = match_offer(
        _p(brand="Apple", title="iPhone 17 Pro 256 Blue"),
        [{"name": "Apple Vision Pro M5 512", "price": 405000}],
    )
    assert m.tier is not MatchTier.HIGH


def test_no_candidates_gives_none_tier():
    m = match_offer(_p(brand="Sony", title="PlayStation 5 Pro"), [])
    assert m.tier is MatchTier.NONE
    assert m.price is None
```

- [ ] **Step 2: Запустить — падают**

Run: `cd backend && python -m pytest tests/test_price_match.py -v`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализовать**

Перенеси логику из `match.py` (scratchpad). Обязательные ворота **до** подсчёта близости — именно они ловят ловушки:

1. **объём памяти** — если обе стороны его называют и он разный, кандидат отбрасывается. Наш объём брать из колонок `storage`/`memory`, а не из названия;
2. **квалификатор** — `air / pro / max / mini / ultra / se / fe / plus`: если одна сторона его называет, а другая нет, кандидат отбрасывается;
3. **поколение чипа** `m\d` — если обе называют и они разные, отбрасывается;
4. **бренд** — конкретные линейки (`iphone`, `macbook`, `ipad`, `airpods`, `vision pro`, `apple watch`) проверяются **раньше** общего слова `apple`.

Порог: `HIGH` при score ≥ 0.65, `REVIEW` при ≥ 0.35, иначе `NONE`. Только `HIGH` можно применять пакетно.

- [ ] **Step 4: Тесты проходят**

Run: `cd backend && python -m pytest tests/test_price_match.py -v`
Expected: 6 passed

- [ ] **Step 5: Коммит**

```bash
git add backend/app/services/price_match.py backend/tests/test_price_match.py
git commit -m "feat(цены): сопоставление прайса с каталогом с воротами по памяти, линейке и чипу"
```

---

## Task 3: Правило скидки

**Files:**
- Create: `backend/app/services/price_rules.py`
- Create: `backend/tests/test_price_rules.py`

Владелец формулировал правило трижды и все три раза по-разному (13650 / 136500 / 139580 от 140000). Итог: «дешевле их цены», величина — настраиваемая, поэтому правило живёт отдельной функцией с параметром, а не константой в трёх местах.

- [ ] **Step 1: Тесты**

```python
from app.services.price_rules import propose_price


def test_subtracts_discount_and_rounds_to_ten():
    assert propose_price(140000, discount=500) == 139500


def test_discount_is_configurable():
    assert propose_price(140000, discount=420) == 139580


def test_never_goes_below_floor():
    assert propose_price(300, discount=500) >= 100


def test_none_price_stays_none():
    assert propose_price(None, discount=500) is None
```

- [ ] **Step 2: Запустить, реализовать, снова запустить**

```python
def propose_price(their_price: float | None, *, discount: int = 500) -> int | None:
    """Наша цена от цены поставщика: минус скидка, округление до 10 ₽.

    Величина скидки — параметр, а не константа: владелец подбирает её на
    живых числах, глядя на всю выдачу сразу, а не по одному примеру.
    """
    if their_price is None:
        return None
    return max(100, round((their_price - discount) / 10) * 10)
```

Run: `cd backend && python -m pytest tests/test_price_rules.py -v`
Expected: 4 passed

- [ ] **Step 3: Коммит**

```bash
git add backend/app/services/price_rules.py backend/tests/test_price_rules.py
git commit -m "feat(цены): правило предлагаемой цены с настраиваемой скидкой"
```

---

## Task 4: Эндпоинты «предпросмотр» и «применить»

**Files:**
- Create: `backend/app/api/price_sync.py`
- Modify: `backend/app/main.py` (регистрация роутера)
- Create: `backend/tests/test_price_sync_api.py`

- [ ] **Step 1: Тесты**

```python
def test_preview_changes_nothing(client, admin_headers, db_session):
    from app.models.product import Product
    before = db_session.query(Product).count()

    resp = client.post("/admin/price-sync/preview", json={
        "text": "iPhone 17 Pro Max 256 Orange — 104.500",
        "discount": 500,
    }, headers=admin_headers)

    assert resp.status_code == 200
    assert db_session.query(Product).count() == before
    rows = resp.json()["rows"]
    assert all("tier" in r and "proposed_price" in r for r in rows)


def test_apply_updates_only_listed_ids(client, admin_headers, db_session):
    from app.models.product import Product
    target = db_session.query(Product).first()
    other = db_session.query(Product).offset(1).first()
    other_price_before = float(other.price)

    resp = client.post("/admin/price-sync/apply", json={
        "updates": [{"product_id": target.id, "price": 12345}],
    }, headers=admin_headers)

    assert resp.status_code == 200
    db_session.refresh(target)
    db_session.refresh(other)
    assert float(target.price) == 12345
    assert float(other.price) == other_price_before


def test_apply_rejects_absurd_price(client, admin_headers, db_session):
    from app.models.product import Product
    target = db_session.query(Product).first()

    resp = client.post("/admin/price-sync/apply", json={
        "updates": [{"product_id": target.id, "price": 0}],
    }, headers=admin_headers)
    assert resp.status_code == 422
```

- [ ] **Step 2: Реализовать роутер**

`POST /admin/price-sync/preview` — принимает сырой текст прайса и скидку, возвращает строки `{product_id, our_title, our_price, their_name, their_price, tier, score, proposed_price, diff}`. **Ничего не меняет.**

`POST /admin/price-sync/apply` — принимает явный список `{product_id, price}` и применяет в одной транзакции. Правило: применяются только те id, которые пришли в запросе — сервер сам ничего не «дорешивает». Цена вне диапазона `100…3 000 000` — `422`.

Защити оба маршрута той же зависимостью админа, что и остальные `/admin/*` (посмотри `backend/app/api/deps.py`).

- [ ] **Step 3: Тесты проходят + полный прогон**

Run: `cd backend && python -m pytest tests/test_price_sync_api.py -v && python -m pytest -q`

- [ ] **Step 4: Коммит**

```bash
git add backend/app/api/price_sync.py backend/app/main.py backend/tests/test_price_sync_api.py
git commit -m "feat(цены): API предпросмотра и применения прайса"
```

---

## Task 5: Экран «Цены» в админке, свёрстанный от телефона

**Files:**
- Create: `admin/src/PriceSync.tsx`
- Modify: `admin/src/App.tsx` (пункт меню и маршрут)

Сейчас `Products.tsx` — таблица с `tableLayout: "fixed"` и инлайн-стилями без единого брейкпоинта: с телефона это горизонтальная прокрутка. Новый экран делаем от узкой ширины.

- [ ] **Step 1: Разметка**

- Поле «вставьте прайс» (`<textarea>`), поле скидки, кнопка «Разобрать».
- Результат: **карточки, а не таблица**. Одна карточка = один товар: наш заголовок, наша цена → предлагаемая, дельта, плашка уверенности, свёрнутый исходный текст объявления.
- Фильтр по уверенности (Все / Уверенно / Проверить / Не найдено) и поиск.
- Чекбокс на карточке; «Выбрать все уверенные» одной кнопкой.
- Кнопка «Применить выбранные (N)» — липкая внизу, большая (палец, а не курсор).
- Цвет дельты: рост и падение читаются разной семантикой, а не только знаком.

- [ ] **Step 2: Обязательные предохранители**

- По умолчанию отмечены **только** `tier === "high"`.
- `review` и `none` отметить можно, но карточка помечена — владелец видит, что берёт риск.
- Перед применением — сводка: сколько товаров, максимальное отклонение, сколько дороже/дешевле.
- Отклонение больше 60% подсвечивается отдельно: именно так вылезли все четыре ловушки сопоставления.

- [ ] **Step 3: Проверки**

Run: `cd admin && npx tsc --noEmit && npm run build`

- [ ] **Step 4: Проверить с телефона**

Открой админку на телефоне, вставь кусок прайса, разбери, примени одну позицию. Убедись: горизонтальной прокрутки нет, кнопки нажимаются пальцем, поле ввода не перекрывается клавиатурой.

- [ ] **Step 5: Коммит**

```bash
git add admin/src
git commit -m "feat(админка): экран синхронизации цен, свёрстанный от телефона"
```

---

## Task 6: Развёртывание

- [ ] **Step 1: Бэкап и деплой**

```bash
bash update-server.sh
```

- [ ] **Step 2: Проверка на реальном прайсе**

Возьми свежий прайс из канала поставщика, разбери, сверь глазами 5–10 позиций с исходником, примени только `high`.

- [ ] **Step 3: Сверить цену в витрине**

Открой мини-апп — цена изменившегося товара должна совпадать с применённой.

---

## Что сюда подключается потом

**DEXA** (собственная система владельца, аналог 1С) встраивается как ещё один источник на входе: контракт `parse → match → preview → apply` от источника не зависит. Когда появится доступ — добавляется адаптер, который отдаёт те же строки `{name, price}`, а сопоставление, пороги и предохранители переиспользуются целиком.

**История цен** для аналитики продаж: отдельная таблица `price_history (product_id, price, changed_at, source)`, пишется в `apply`. Нужна до того, как появится трекинг динамики — задним числом историю не восстановить.

---

## Definition of done

- [ ] `cd backend && python -m pytest -q` — зелёный, все пять ловушек закрыты тестами
- [ ] Прайс из канала разбирается без фальшивых позиций-годов
- [ ] Предпросмотр не меняет ни одной цены
- [ ] Применение меняет ровно те товары, что отмечены
- [ ] Экран работает с телефона без горизонтальной прокрутки
