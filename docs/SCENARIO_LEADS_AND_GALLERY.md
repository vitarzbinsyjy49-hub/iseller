# Сценарные заявки + галерея до 10 фото (v5.4.0)

Патч добавляет встроенные сценарные заявки (Trade-In / Для бизнеса / Опт) вместо
ухода к менеджеру, меню подбора MacBook, единый лимит 10 фото на товар с
мультизагрузкой и порядком, карусель фото на карточках (как в Яндекс Лавке) и
read-only аудит покрытия каталога фотографиями.

Совместимо со старым backend/CRM/Telegram Mini App/AI gateway; production не
затрагивается этим патчем.

---

## 1. Контракт заявки (Lead)

`Lead` расширен обратносовместимо двумя полями:

| Поле | Тип | Назначение |
|---|---|---|
| `lead_type` | `general \| product \| trade_in \| b2b \| wholesale` | продуктовый сценарий заявки |
| `metadata` | JSON-object | структурированные ответы сценария |

- **`source` НЕ меняется** — это канал происхождения (`home`, `product`, `ai`, …).
  Тип сценария живёт отдельно в `lead_type`.
- `origin` (например `home_quick_scenario`) хранится ВНУТРИ `metadata`.
- ORM-атрибут называется `Lead.meta` (имя `metadata` зарезервировано declarative
  Base), но DB-колонка и JSON-ключ ответа — `metadata`.

### `POST /api/leads` (JWT пользователя)

```jsonc
{
  "source": "home",
  "lead_type": "trade_in",
  "phone": "+7 900 000-00-00",   // опц.
  "message": "свободный комментарий", // опц.
  "metadata": {
    "origin": "home_quick_scenario",
    "device_type": "iphone",
    "model": "iPhone 15 Pro",
    "condition": "normal",
    "intent": "exchange"
  }
}
```

Правила безопасности:

- Клиент **не может** задать `status`, `telegram_id`, `username`, `assigned_to` —
  их нет в схеме `LeadIn`; identity берётся из JWT, `status` всегда `new`.
- Старый POST без `lead_type`/`metadata` → `lead_type="general"`, `metadata={}`.
- Неизвестный `lead_type` **нормализуется** в `general` (не 500).
- `metadata` санитайзится: только object; ≤24 ключей; ключ ≤40 симв.; строка ≤500
  симв.; общий сериализованный размер ≤4000 байт; значения — скаляры или короткий
  список скаляров; неизвестные ключи допускаются, но лишнее отбрасывается; не-object
  → `422`.
- Событие аналитики `lead_created` содержит только `lead_id/source/lead_type/product_id`
  — без телефона/имени/комментария/metadata (без PII).

### Отдача

`Lead.to_dict()` теперь возвращает `lead_type` и `metadata`. Пользовательский
экран `/requests` и админка рендерят человекочитаемый заголовок и локализованные
поля metadata (не сырой JSON) — см. `frontend/src/lib/leads.ts`,
`admin/src/ui.ts::leadMetaRows`.

### Админка заявок

- Pill типа: Обычная / Товар / Trade-In / Для бизнеса / Опт.
- Фильтр `GET /api/admin/leads?type_filter=<lead_type>` (старый `source_filter`
  и `status_filter` не сломаны).

---

## 2. ScenarioRequestSheet / ScenarioChoiceSheet (frontend)

`frontend/src/components/ScenarioSheet.tsx` + чистая логика в
`frontend/src/lib/scenario.ts`.

- Один конфигурируемый bottom-sheet (mobile) / центр-модалка (desktop): portal в
  `document.body`, drag handle, крестик, закрытие по backdrop и Escape, блокировка
  фонового скролла без прыжка, safe-area, focus-trap, haptic, защита от двойной
  отправки, inline-валидация, error/retry. `prefers-reduced-motion` — глобально в
  `index.css`.
- Три сценария (Trade-In / B2B / Опт) описаны конфигом (chips + text + textarea).
- Контакт: телефон **необязателен**, если у пользователя есть Telegram `@username`
  (менеджер ответит в Telegram); **обязателен**, если username нет.
- Success-state: «Заявка отправлена» → «Посмотреть заявку» (`/requests`) +
  вторичная «Написать менеджеру сейчас» (только если для сценария настроена ссылка
  менеджера в public config). Переход в Telegram — только по явному клику.
- MacBook: `ScenarioChoiceSheet` с 5 пунктами → `/ai?q=<prefill>` **без**
  авто-отправки; 5-й пункт — мягкий пошаговый подбор. Заявка тут НЕ создаётся.
- iPhone / Аксессуары — как раньше, прямой переход в каталог.

Аналитика (в общий allowlist, только безопасные метаданные):
`scenario_sheet_opened`, `scenario_option_selected`, `scenario_lead_submitted`,
`scenario_lead_success`, `scenario_lead_failed`.

---

## 3. Галерея: единый лимит 10 фото

`MAX_PRODUCT_IMAGES = 10` — одна константа (`backend/app/core/uploads.py`),
enforced во ВСЕХ путях: ручная загрузка, мультизагрузка, ZIP, batch/import,
CSV/JSON/XLSX, image-groups, set-main, reorder, delete, resolver.

`normalize_gallery(urls, main=…)` → `(images, excess)`: дедуп, без пустых, главная
первой, ≤10; лишнее — в `excess` (не теряется молча).

Инварианты:

- порядок стабилен; URL без дублей/пустых;
- главная = `images[0]`; `product.image` синхронизировано с `images[0]`;
- **set main** переставляет URL на индекс 0 (не просто отдельное поле);
- **delete main** делает главной первую оставшуюся;
- пустая галерея → `image = null`;
- 11-е фото не принимается — `400` с текущим количеством и лимитом;
- resolver и `to_card()`/`to_detail()` никогда не отдают >10;
- ZIP/импорт с >10 фото одного SKU: первые 10 по текущей сортировке применяются,
  остальные — в отчёт `excess_images` (на диск не пишутся).

### Эндпоинты (admin)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/admin/products/{id}/images` | одно фото (лимит enforced) |
| POST | `/api/admin/products/{id}/images/bulk` | мультизагрузка (`files[]`), отчёт `_upload` |
| POST | `/api/admin/products/{id}/images/main` | сделать главной (→ индекс 0) |
| POST | `/api/admin/products/{id}/images/reorder` | сохранить порядок (валидирует тот же набор URL) |
| DELETE | `/api/admin/products/{id}/images` | удалить (главная → первая оставшаяся) |

`reorder` отклоняет добавление/удаление/дубли URL — только перестановка.

### Карточки (`to_card`) и карусель

`to_card()` теперь возвращает `images`. `apply_group_images()` (уже вызывается во
всех card-эндпоинтах: `/catalog/{list,search,feed,recommendations,recently-viewed}`,
детали, AI-fallback) проставляет эффективную групповую галерею одним батчем
(без N+1). `image` остаётся для обратной совместимости.

`ProductCard` (`frontend/src/components/ProductCard.tsx`, логика жестов —
`frontend/src/lib/carousel.ts`): 0 фото — placeholder; 1 — без точек; 2–10 —
свайп + точки по центру (как в Лавке), активная точка выделена; свайп подавляет
открытие товара, тап открывает; вертикальный скролл не блокируется
(`touch-action: pan-y`); монтируются только активный слайд и соседи (lazy);
индекс сбрасывается при смене `card.id`/набора фото; битое фото безопасно;
a11y «Фото N из M». `ProductDetails` — точки кликабельны, максимум 10.

### Админка: мультизагрузка и порядок

`admin/src/Products.tsx`: `multiple` file input + drag-and-drop нескольких файлов,
счётчик «Фотографии · N/10», отчёт частичного результата (добавлено / отклонено с
причиной), кнопки ← → для порядка (keyboard-accessible), «Главная» ставит фото
первым. Порядок сохраняется отдельным валидируемым эндпоинтом и переживает reload.

---

## 4. Аудит покрытия фото (read-only)

`scripts/photo_coverage_audit.py` — постоянный read-only инструмент по ВСЕМУ
каталогу, считает покрытие **по эффективным группам фото** (модель+цвет), без
записи в БД.

```bash
DATABASE_URL="sqlite:///demo.db" python scripts/photo_coverage_audit.py \
    --out docs/photo-research --target 3
```

**Безопасный запуск на проде (данные НЕ меняются):**

```bash
# DATABASE_URL взять из окружения backend-контейнера (или указать реплику/дамп)
docker compose -f docker-compose.prod.yml exec -T backend \
    sh -c 'cd /code && DATABASE_URL="$DATABASE_URL" python /code/scripts/photo_coverage_audit.py --out /tmp/photo-audit --source-label prod'
# затем скопировать /tmp/photo-audit наружу: docker compose cp backend:/tmp/photo-audit ./
```

> Скрипт делает только `SELECT`'ы к `products` / `product_image_groups`. Он не
> пишет в БД, не скачивает и не подставляет изображения.

Выход: `summary.md`, `coverage.csv`, `coverage.json` в `docs/photo-research/<YYYY-MM-DD>/`.
Метрики: без фото / 1 / 2–3 / 4–10 / >10 до нормализации, плейсхолдеры, внешние и
локальные URL, дубли в галерее, кросс-группное переиспользование URL, покрытие по
категориям/брендам/в наличии/hot-new-today, приоритет P0/P1/P2. Плейсхолдер-SVG
сида НЕ считается реальным фото.

Та же логика — в админке: `GET /api/admin/photo-coverage` (read-only, батч, без
внешних URL-проверок при открытии) → раздел «Медиа» (сводка + фильтры + приоритетная
таблица + экспорт CSV).

---

## 5. Research фотографий (политика)

`docs/photo-research/<date>/research.{md,csv}` — один research на canonical
`image_group_key`.

- Только **официальные** источники: сайт производителя / newsroom / press / media
  kit; затем авторизованный дистрибьютор. НЕ маркетплейсы/объявления/водяные
  знаки/пользовательские фото/неизвестные CDN/другой цвет-поколение.
- **Не hotlink-им** внешние URL в прод-каталог, **не** пишем candidate URL в
  `Product` автоматически, **не** скачиваем/коммитим массив фото без отдельного
  подтверждения.
- Статусы: `verified` / `needs_review` / `unresolved`. Ничего не выдумываем: нет
  источника/доступа → `unresolved`.
- Реальную подстановку найденных фото делать отдельным шагом после ручного approve
  — через импорт групп (`/api/admin/import/image-groups/*`), не хардкодом.

---

## 6. Совместимость и Mac mini / AI gateway

- Контракт AI (`ai_schemas.py`, `ai-gateway/main.py`) **не менялся** — подключение
  Mac mini (`AI_PROVIDER=ollama_remote`) работает как прежде. AI-fallback карточки
  дополнительно получают эффективную галерею через тот же resolver (без N+1).
- Старые заявки (без `lead_type`/`metadata`), старые товары (одно `image`), image
  groups, Telegram safe-area — не затронуты.

---

## 7. Rollback

- **Код:** `git switch master` (ветка патча — `feature/scenario-leads-photo-gallery-v5.4.0`),
  либо восстановление из out-of-repo backup (bundle + tar + checksums).
- **БД (колонки заявок):** новые колонки обратносовместимы (nullable/default).
  Откат кода без удаления колонок безопасен — старый код их просто игнорирует.
  Если требуется убрать колонки:
  ```sql
  ALTER TABLE leads DROP COLUMN IF EXISTS lead_type;
  ALTER TABLE leads DROP COLUMN IF EXISTS metadata;
  DROP INDEX IF EXISTS ix_leads_lead_type;
  ```
  Данные фото (`products.image/images`) миграциями не менялись — откат не нужен.
- Миграции идемпотентны (`ADD COLUMN IF NOT EXISTS`) и безопасны для повторного
  прогона.
