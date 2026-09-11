# Предзаказ линейки Apple — план реализации

> Спека: [2026-09-11-preorder-apple-2026-design.md](../specs/2026-09-11-preorder-apple-2026-design.md)

**Цель:** завести карточки предзаказа (товар без цены, с ожидаемой датой и своим
акцентом), экран события с чередованием «описание → карточка», баннер линейки
Apple первым на главной и секцию «Предзаказ» там же.

**Архитектура:** режим `availability_mode="preorder"` уже существует и работает
сквозняком. Достраиваем вокруг него три колонки, одну ступень в сортировке, один
эндпоинт, один экран и одну секцию. Новых таблиц нет: событие описывает баннерная
строка, которая на него ведёт.

**Стек:** FastAPI + SQLAlchemy + PostgreSQL, React/Vite (frontend и admin).

## Глобальные ограничения

- Цена предзаказа **не показывается нигде**: `price = 0`, витрина рисует
  `price_note` = «Цену уточнит менеджер».
- Срок — **строка**, не дата: `preorder_eta` = «18 сентября».
- Анимации, которые человек должен увидеть, пишутся через `lib/motion.ts`
  (rAF). CSS `@keyframes`/`transition` в webview Telegram не проигрываются.
- Фото: внешние Scene7-ссылки временные, после сида обязателен
  `internalize_photos --confirm`.
- Баннер: `frontend/public/assets/promos/apple-sept-2026.webp`, 1536×1200 (3:2).
- Проверка перед «готово»: `pytest -q` в backend, `tsc --noEmit && vitest run &&
  npm run build` во frontend, `tsc --noEmit && npm run build` в admin.

---

### Задача 1: колонки и выдача карточки

**Файлы:** `backend/app/models/product.py`, `backend/app/main.py`,
тест `backend/tests/test_preorder.py`

**Produces:** `Product.preorder_eta: str|None`, `Product.preorder_group: str|None`,
`Product.accent_color: str|None`; `to_card()` отдаёт `preorder_eta`,
`accent_color`, `price_note: str` («» у обычного товара).

- [ ] Тест: у товара с `availability_mode="preorder"` `to_card()["price_note"]`
      равен «Цену уточнит менеджер», у обычного — пустая строка.
- [ ] Тест: `preorder_eta` и `accent_color` доезжают до `to_card()` и `to_admin()`.
- [ ] Три колонки в модели + мини-миграции рядом с `availability_mode`.
- [ ] `PRICE_NOTE = "Цену уточнит менеджер"` живёт в `services/availability.py`
      рядом с `AVAILABILITY_LABEL` — одно место на весь проект.
- [ ] Прогнать, закоммитить.

### Задача 2: ступень предзаказа в сортировке

**Файлы:** `backend/app/services/ranking.py`, `backend/tests/test_ranking.py`

**Consumes:** `Product.availability_mode` из задачи 1.

Ключ становится: `is_legendary → preorder → in_stock → popularity → плитка →
цена → id`. Правится и `product_sort_key` (питон), и `order_by_clauses` (SQL) —
два порядка обязаны совпадать.

- [ ] Тест: предзаказ стоит выше товара в наличии, но ниже легендарного.
- [ ] Тест: детерминированность не сломана (существующий тест должен пройти).
- [ ] Реализовать, прогнать, закоммитить.

### Задача 3: эндпоинт события

**Файлы:** `backend/app/api/preorder.py` (создать), `backend/app/main.py`
(роутер), `backend/app/models/home.py` (`ACTION_TYPES`), тесты.

**Produces:** `GET /api/preorder/{group}` → `{"banner": {...}|None, "items": [card]}`.
Товары: `is_active`, `availability_mode="preorder"`, `preorder_group=group`,
порядок `id ASC`. Баннер — строка `home_banners` с `action_type="preorder"` и
`action_value=group`.

- [ ] Тест: пустая группа → `items: []`, 200 (не 404: группа могла опустеть,
      когда товары приехали, и это нормальное состояние, а не ошибка).
- [ ] Тест: неактивные и чужой группы не попадают; порядок по id.
- [ ] Реализовать, прогнать, закоммитить.

### Задача 4: секция «Предзаказ» и невидимость для AI

**Файлы:** `backend/app/api/catalog.py` (`/catalog/feed`),
`backend/app/services/ai_retrieval.py`, тесты.

- [ ] Тест: `/catalog/feed` отдаёт ключ `preorder`; пустой при отсутствии таких
      товаров.
- [ ] Тест: `retrieve_candidates` и `_token_pool` предзаказ не возвращают.
- [ ] Реализовать: фильтр `availability_mode.is_distinct_from("preorder")` —
      рядом с `exclude_marketplace`, тем же приёмом.
- [ ] Прогнать, закоммитить.

### Задача 5: админка

**Файлы:** `backend/app/api/admin_crm.py` (`_PRODUCT_EDITABLE`),
`admin/src/Products.tsx`, `admin/src/HomeAdmin.tsx`.

- [ ] Три поля в белый список полей товара.
- [ ] Три поля в форму товара: «Ожидается», «Группа предзаказа», «Акцент».
- [ ] `preorder` в выбор типа действия баннера.
- [ ] `tsc --noEmit && npm run build`, закоммитить.

### Задача 6: карточка на витрине

**Файлы:** `frontend/src/components/ai/types.ts`,
`frontend/src/components/ProductCard.tsx`, `frontend/src/pages/ProductDetails.tsx`.

- [ ] Типы: `preorder_eta?`, `accent_color?`, `price_note?`.
- [ ] Вместо цены — `price_note`, когда он непустой.
- [ ] Строка «Ожидается …» под названием.
- [ ] Кнопка «Оформить предзаказ» вместо корзины (ведёт на карточку товара, где
      живёт заявка) — переиспользуем ветку `!orderable` в `CardCartControl`.
- [ ] На деталке: цена скрыта, CTA — заявка, «Спросить AI» даёт честный ответ.
- [ ] `tsc --noEmit && vitest run && npm run build`, закоммитить.

### Задача 7: экран события

**Файлы:** `frontend/src/components/PreorderEvent.tsx` (создать),
`frontend/src/pages/PreorderPage.tsx` (создать), `frontend/src/App.tsx` (роут),
`frontend/src/lib/route.ts` (`actionRoute`), `frontend/src/lib/route.test.ts`.

- [ ] Тест: `actionRoute("preorder", "apple-sept-2026")` → `/preorder/apple-sept-2026`.
- [ ] Экран: живой фон на канве через rAF (48×88, 24 кадра/с, стоп при скрытой
      вкладке и при `prefers-reduced-motion`), шапка с афишей, чередование
      «описание → карточка».
- [ ] Роут `/preorder/:group` через `DeferredPage`.
- [ ] Проверки, закоммитить.

### Задача 8: секция на главной

**Файлы:** `frontend/src/pages/Home.tsx`.

- [ ] Тип `Feed` += `preorder`.
- [ ] `<Section title="Предзаказ" cards={feed?.preorder} onAll={…}/>` первой
      среди товарных секций. Пустой массив `Section` уже гасит сам.
- [ ] Проверки, закоммитить.

### Задача 9: контент и сид

**Файлы:** `backend/app/scripts/seed_preorder_apple_2026.py` (создать).

- [ ] Идемпотентно по `sku`: шесть товаров, категории, описания, характеристики,
      `preorder_eta`, `preorder_group="apple-sept-2026"`, `accent_color`,
      галереи из `product-photos/preorder-apple-2026/manifest.json`.
- [ ] Баннер `home_banners`: `position=0`, `action_type="preorder"`,
      `action_value="apple-sept-2026"`, `image_url=/assets/promos/apple-sept-2026.webp`.
      Существующим баннерам сдвинуть `position` на +1, чтобы ГТА стал вторым.
- [ ] Закоммитить.

### Задача 10: прод

- [ ] Полный прогон всех трёх проверок.
- [ ] Деплой (`bash update-server.sh` из Git Bash — запускает владелец).
- [ ] На проде: сид, затем `internalize_photos --confirm`.
