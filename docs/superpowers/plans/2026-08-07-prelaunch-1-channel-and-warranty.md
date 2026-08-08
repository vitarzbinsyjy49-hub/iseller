# PreLaunch Patch, фаза 1: канал и гарантия

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Гарантия «1 месяц» звучит одинаково в карточках товара и в канале, а четыре инфо-поста перестают быть черновиками и выходят в канал.

**Architecture:** Тексты постов живут в БД (`channel_posts.body`), а `INFO_POSTS` в коде — только заготовка для первичного посева. Поэтому правим оба слоя: код (чтобы новый посев был верным) и данные на проде (чтобы изменилось то, что реально уходит в канал). Публикацию делает существующий `apply_info_posts`, который сам отказывается печатать текст с маркером `[уточнить]`.

**Tech Stack:** FastAPI + SQLAlchemy, pytest, Telegram Bot API через `telegram_publisher`.

---

## Контекст, который сэкономит время

Факты, проверенные на проде 07.08.2026 — не перепроверяй, но и не считай вечными:

| факт | значение |
|---|---|
| `warranty_months` у всех активных товаров | `0` — то есть строка «Гарантия» в карточке **не выводится вообще** |
| инфо-посты в БД | `info_warranty`, `info_delivery`, `info_payment`, `info_preorder` — `draft`, все с `[уточнить]` |
| `info_about` | **`published`, `telegram_message_id = 17`** — единственный живой инфо-пост |
| «14 дней» в живых текстах | `info_warranty` (черновик) и `info_about` (**опубликован**) |
| «14 дней» в коде | `info_posts.py` строки 35 (комментарий), 45 (`info_warranty`), 118 (`info_about`) |

Ключевой механизм: `price_channel.apply_info_posts()` берёт текст из `row.body` (БД), а **не** из `INFO_POSTS`. Правка одного кода канал не изменит.

`has_placeholders()` (`info_posts.py:128`) блокирует публикацию, если в тексте остался `[уточнить]`. Это защита, а не баг — снимать её нельзя.

---

## Task 1: Гарантия 1 месяц в карточках товара

**Files:**
- Modify: `backend/app/services/info_posts.py:35,45,118`
- Test: `backend/tests/test_info_posts.py`

- [ ] **Step 1: Найти существующие тесты инфо-постов**

```bash
cd backend && ls tests/ | grep -i "info\|post"
```

Если файла `test_info_posts.py` нет — создай его на шаге 2. Если есть — дописывай в него.

- [ ] **Step 2: Написать падающий тест на срок гарантии**

Добавь в `backend/tests/test_info_posts.py`:

```python
from app.services.info_posts import INFO_BY_SLUG


def test_warranty_post_states_one_month():
    """Срок гарантии в канале обязан совпадать с карточкой товара.

    Раньше здесь стояло «14 дней», а warranty_months у всех товаров был 0 —
    канал обещал одно, карточка не обещала ничего. Тест держит один срок.
    """
    body = INFO_BY_SLUG["info_warranty"].default_text
    assert "1 месяц" in body
    assert "14 дней" not in body


def test_about_post_states_one_month():
    body = INFO_BY_SLUG["info_about"].default_text
    assert "14 дней" not in body
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `cd backend && python -m pytest tests/test_info_posts.py -k "one_month" -v`
Expected: FAIL — `assert "1 месяц" in body`, потому что в тексте пока «Гарантия 14 дней».

- [ ] **Step 4: Поправить тексты в коде**

В `backend/app/services/info_posts.py` заменить в трёх местах:

Строка 35 (комментарий-обоснование):
```python
#: — гарантия 1 месяц стоит в каждой карточке каталога (warranty_months=1);
```

Строка 45 (`info_warranty`):
```python
        "<b>Гарантия 1 месяц</b> на всю технику из прайса.\n"
```

Строка 118 (`info_about`):
```python
        "<b>Проверка при вас, гарантия 1 месяц, честные цены.</b>\n"
```

- [ ] **Step 5: Убедиться, что тест проходит**

Run: `cd backend && python -m pytest tests/test_info_posts.py -k "one_month" -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Прогнать весь бэкенд — не сломали ли соседние тесты**

Run: `cd backend && python -m pytest -q`
Expected: `791 passed` (или больше на 2 новых теста). Если какой-то тест ждал «14 дней» — поправь его, срок изменился осознанно.

- [ ] **Step 7: Коммит**

```bash
git add backend/app/services/info_posts.py backend/tests/test_info_posts.py
git commit -m "feat(канал): гарантия 1 месяц вместо 14 дней в заготовках постов"
```

---

## Task 2: `warranty_months = 1` у всех товаров

Сейчас у всех 216 товаров стоит `0`, и метод `Product.specs()` (`models/product.py:253`) строку «Гарантия» просто не добавляет — карточка о гарантии молчит. Ставим 1, чтобы карточка и канал говорили одно.

**Files:**
- Test: `backend/tests/test_product_specs.py` (или существующий тест спеков)
- Create: `backend/scripts/set_default_warranty.sql`

- [ ] **Step 1: Проверить, как формируется строка гарантии**

Run: `cd backend && sed -n '250,258p' app/models/product.py`
Expected: увидишь `if self.warranty_months:` и `add("Гарантия", f"{self.warranty_months} мес.")` — то есть при 0 строки нет, а при 1 будет «Гарантия: 1 мес.».

- [ ] **Step 2: Написать падающий тест**

```python
def test_warranty_shows_in_specs_when_set():
    from app.models.product import Product

    p = Product(title="Тест", price=1000, warranty_months=1)
    specs = p.specs()
    assert specs.get("Гарантия") == "1 мес."


def test_warranty_hidden_when_zero():
    """0 — это «не обещаем», и обещание не должно появляться само."""
    from app.models.product import Product

    p = Product(title="Тест", price=1000, warranty_months=0)
    assert "Гарантия" not in p.specs()
```

- [ ] **Step 3: Запустить тест**

Run: `cd backend && python -m pytest tests/test_product_specs.py -k warranty -v`
Expected: PASS обоих — поведение уже такое, тест фиксирует его перед правкой данных. Если тест упал, поправь его под реальную форму `specs()` (ключ мог называться иначе) и только потом иди дальше.

- [ ] **Step 4: Создать SQL правки данных**

Create `backend/scripts/set_default_warranty.sql`:

```sql
-- Гарантия 1 месяц на всю активную технику.
-- Раньше у всех стоял 0, и карточка про гарантию молчала, пока канал обещал
-- 14 дней. Ставим 1 там, где значение не задано осознанно (0), и не трогаем
-- товары, которым срок уже проставили руками.
BEGIN;
UPDATE products SET warranty_months = 1 WHERE is_active = true AND warranty_months = 0;
SELECT warranty_months, count(*) FROM products WHERE is_active = true GROUP BY 1 ORDER BY 1;
COMMIT;
```

- [ ] **Step 5: Прогнать локально и проверить**

```bash
docker compose -f docker-compose.demo.yml exec -T db psql -U techshop -d techshop -f - < backend/scripts/set_default_warranty.sql
```

Expected: `UPDATE 216` и таблица, где `warranty_months = 1` у всех активных.

- [ ] **Step 6: Проверить карточку в браузере**

```bash
docker compose -f docker-compose.demo.yml restart frontend
```

Открой `http://localhost:5173`, зайди в любой товар — в характеристиках должна появиться строка «Гарантия: 1 мес.».

- [ ] **Step 7: Коммит**

```bash
git add backend/scripts/set_default_warranty.sql backend/tests/test_product_specs.py
git commit -m "feat(каталог): гарантия 1 месяц во всех карточках"
```

---

## Task 3: Заполнить четыре черновика инфо-постов

Шесть маркеров `[уточнить]` в четырёх постах. Тексты ниже — **черновик, который владелец обещал вычитать**. Всё, что здесь придумано и требует подтверждения, помечено в конце задачи отдельным списком — не пропусти его.

**Важно:** адрес и часы берём из НАШЕГО проекта (`info_posts.py`, экран «Профиль»): «Горбушка, Москва, ежедневно 10:00–21:00». В выгрузке Telegram-канала конкурента есть другой адрес (Багратионовский пр. 7к3, А1-031) — это **их** точка, переносить её к нам нельзя.

**Files:**
- Modify: `backend/app/services/info_posts.py` (заготовки)
- Create: `backend/scripts/fill_info_posts.sql` (данные прода)

- [ ] **Step 1: Написать падающий тест «в заготовках не осталось дыр»**

```python
from app.services.info_posts import INFO_POSTS, has_placeholders


def test_no_placeholders_left_in_defaults():
    """Заготовка с [уточнить] не публикуется — значит пост в канал не выйдет.

    Тест держит инвариант: любой пост, добавленный в INFO_POSTS, приходит
    с готовым текстом, а не с напоминанием дописать его потом.
    """
    unfilled = [p.slug for p in INFO_POSTS if has_placeholders(p.default_text)]
    assert unfilled == []
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd backend && python -m pytest tests/test_info_posts.py -k placeholders -v`
Expected: FAIL — `assert ['info_warranty', 'info_delivery', 'info_payment', 'info_preorder'] == []`

- [ ] **Step 3: Заполнить `info_warranty`**

В `info_posts.py` заменить строку с `Обмен и возврат` на:

```python
        "<b>Обмен и возврат:</b> если устройство неисправно — меняем на "
        "аналогичное или возвращаем деньги в течение 1 месяца с покупки. "
        "Товар должен быть в полном комплекте и без следов механических "
        "повреждений и попадания влаги.",
```

- [ ] **Step 4: Заполнить `info_delivery`**

Заменить две строки с `PLACEHOLDER`:

```python
        "<b>Доставка по Москве:</b> курьером в день заказа или на следующий "
        "день, 500 ₽. При заказе от 50 000 ₽ — бесплатно.\n"
        "\n"
        "<b>Доставка по России:</b> СДЭК до пункта выдачи, 3–7 дней. "
        "Стоимость считает менеджер по вашему городу, оплата — после "
        "подтверждения наличия.\n"
```

- [ ] **Step 5: Заполнить `info_payment`**

```python
        "<b>Способы оплаты:</b> наличными при получении, переводом по СБП "
        "или картой по QR-коду.\n"
        "\n"
        "<b>Оплата при самовывозе:</b> после проверки товара — сначала "
        "включаем и смотрим вместе, потом оплата.\n"
        "\n"
        "<b>Для юридических лиц:</b> выставляем счёт, работаем по договору. "
        "Напишите менеджеру — уточним документы под вашу бухгалтерию.\n"
```

- [ ] **Step 6: Заполнить `info_preorder`**

```python
        "<b>Обычный срок поставки:</b> 3–10 дней в зависимости от модели и "
        "региона поставки. Точный срок менеджер называет до предоплаты.\n"
```

- [ ] **Step 7: Тест проходит**

Run: `cd backend && python -m pytest tests/test_info_posts.py -v`
Expected: PASS всех тестов файла.

- [ ] **Step 8: Полный прогон бэкенда**

Run: `cd backend && python -m pytest -q`
Expected: все зелёные.

- [ ] **Step 9: Коммит**

```bash
git add backend/app/services/info_posts.py backend/tests/test_info_posts.py
git commit -m "feat(канал): заполнены заготовки инфо-постов, дыр [уточнить] не осталось"
```

**⚠️ Что здесь придумано и требует подтверждения владельца перед публикацией:**

| место | придуманное значение |
|---|---|
| Возврат | 1 месяц, без механических повреждений и влаги |
| Доставка по Москве | 500 ₽, бесплатно от 50 000 ₽, день в день / следующий день |
| Доставка по России | СДЭК до ПВЗ, 3–7 дней |
| Оплата | наличные, СБП, QR |
| Юрлица | счёт + договор |
| Предзаказ | 3–10 дней |

Ни одно из этих чисел не взято из проекта — они правдоподобны, но это обещания клиентам. Публиковать только после «ок».

---

## Task 4: Перенести тексты в БД прода и опубликовать

Код исправлен, но канал читает БД. Здесь — единственная часть плана, которая меняет то, что видят люди.

**Files:**
- Create: `backend/scripts/fill_info_posts.sql`

- [ ] **Step 1: Сгенерировать SQL из заготовок**

Напиши одноразовый скрипт `backend/scripts/dump_info_posts_sql.py`, который берёт `INFO_POSTS` и печатает `UPDATE`-ы:

```python
"""Перенести заготовки инфо-постов в БД.

Тексты живут в двух местах: INFO_POSTS (посев) и channel_posts.body (то, что
реально уходит в канал). Скрипт синхронизирует второе с первым для постов,
которые ещё никто не правил руками в админке.
"""
from app.services.info_posts import INFO_POSTS

print("BEGIN;")
for post in INFO_POSTS:
    body = post.default_text.replace("'", "''")
    print(
        f"UPDATE channel_posts SET body = '{body}' "
        f"WHERE slug = '{post.slug}' AND kind = 'info';"
    )
print("SELECT slug, status, length(body) FROM channel_posts WHERE kind='info' ORDER BY id;")
print("COMMIT;")
```

Run: `cd backend && python scripts/dump_info_posts_sql.py > scripts/fill_info_posts.sql`

- [ ] **Step 2: Проверить кодировку файла**

Run: `cd backend && head -3 scripts/fill_info_posts.sql`
Expected: читаемая кириллица. Если кракозябры — пересохрани в UTF-8; кириллицу на прод передаём только файлом через `scp`, пайп из PowerShell портит кодировку.

- [ ] **Step 3: Прогнать локально**

```bash
docker compose -f docker-compose.demo.yml exec -T db psql -U techshop -d techshop -f - < backend/scripts/fill_info_posts.sql
```

Expected: 5 × `UPDATE 1`, в таблице ни у одного поста не осталось `[уточнить]`.

- [ ] **Step 4: СТОП — показать владельцу**

Покажи итоговые тексты и таблицу придуманных условий из Task 3. **Не публиковать в канал без явного «ок»** — это обещания клиентам и правка живого сообщения `info_about` (message_id 17).

- [ ] **Step 5: Бэкап прода**

```bash
ssh iseller "cd /opt/techshop && docker compose -f docker-compose.prod.yml exec -T db sh -c 'pg_dump -U \$POSTGRES_USER \$POSTGRES_DB' | gzip > /opt/backups/techshop_pre_info_posts_\$(date +%F_%H%M).sql.gz && ls -lht /opt/backups | head -3"
```

- [ ] **Step 6: Залить тексты на прод**

```bash
scp backend/scripts/fill_info_posts.sql iseller:/tmp/fill_info_posts.sql
ssh iseller "cd /opt/techshop && docker compose -f docker-compose.prod.yml cp /tmp/fill_info_posts.sql db:/tmp/f.sql && docker compose -f docker-compose.prod.yml exec -T db psql -U techshop -d techshop -f /tmp/f.sql"
```

Expected: 5 × `UPDATE 1`, `COMMIT`.

- [ ] **Step 7: Сухой прогон публикации**

Найди эндпоинт публикации инфо-постов в админке (`backend/app/api/posts.py`) и вызови его с `dry_run=true`, либо через раздел «Посты канала» в админке.
Expected: `created: [info_warranty, info_delivery, info_payment, info_preorder]`, `updated: [info_about]`, `failed: []`.

Если в `failed` есть «в тексте остались незаполненные места» — значит какой-то `[уточнить]` уцелел; вернись к Task 3.

- [ ] **Step 8: Публикация**

Через админку «Посты канала» → опубликовать. Пять сообщений: четыре новых, одно (`info_about`) редактируется на месте.

- [ ] **Step 9: Проверить канал**

```bash
ssh iseller "cd /opt/techshop && docker compose -f docker-compose.prod.yml exec -T db psql -U techshop -d techshop -c \"SELECT slug, status, telegram_message_id FROM channel_posts WHERE kind='info' ORDER BY id;\""
```

Expected: у всех пяти `status = published` и непустой `telegram_message_id`.

Открой канал `@isellerhub` глазами: посты на месте, кнопки работают, «1 месяц» везде.

- [ ] **Step 10: Коммит**

```bash
git add backend/scripts/
git commit -m "chore(канал): скрипты переноса инфо-постов и гарантии в БД"
```

---

## Task 5: Гарантия на проде

- [ ] **Step 1: Бэкап уже сделан в Task 4 Step 5** — если между задачами прошло время, повтори.

- [ ] **Step 2: Применить**

```bash
scp backend/scripts/set_default_warranty.sql iseller:/tmp/warranty.sql
ssh iseller "cd /opt/techshop && docker compose -f docker-compose.prod.yml cp /tmp/warranty.sql db:/tmp/w.sql && docker compose -f docker-compose.prod.yml exec -T db psql -U techshop -d techshop -f /tmp/w.sql"
```

Expected: `UPDATE 216`, затем таблица с единственной строкой `1 | 216`.

- [ ] **Step 3: Проверить в живом мини-аппе**

Открой `https://158.255.1.248.sslip.io` через бота, зайди в любой товар — «Гарантия: 1 мес.» в характеристиках.

- [ ] **Step 4: Health**

```bash
curl -s https://158.255.1.248.sslip.io/api/health
```
Expected: `{"status":"ok","database":"ok"}`

---

## Definition of done

- [ ] `cd backend && python -m pytest -q` — зелёный
- [ ] В канале пять инфо-постов, ни в одном нет `[уточнить]`
- [ ] «1 месяц» в канале и «Гарантия: 1 мес.» в карточке — один и тот же срок
- [ ] Владелец подтвердил придуманные условия из таблицы в Task 3
- [ ] Аватарка канала поставлена вручную (`frontend/public/assets/brand/logo-icon.png`) — бот менять фото канала не может
