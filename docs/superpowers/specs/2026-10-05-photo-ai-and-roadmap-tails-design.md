# Фото-ИИ (поиск и Trade-In) + хвосты роудмапа

Дата: 2026-10-05. Решение владельца: берём «Фото: поиск + Trade-In» и «Закрыть
хвосты роудмапа». Делаем параллельно двумя потоками.

## Сверка роудмапа на 05.10 (основание)

| пункт | период | факт |
|---|---|---|
| referral, points-in-cart, points-auto, ai-in-card | sep/oct | сделано, отмечено |
| price-tracker | sep | **сделано, не отмечено**: `services/favorite_watch.py` — «подешевело / снова в наличии» через outbox; работает в цикле бота |
| ai-compare | later | **сделано, не отмечено**: `components/ai/CompareTable.tsx` в чате |
| pickup-point | sep | почти: «Самовывоз · Горбушка» и часы есть, нет маршрута |
| points-notify | oct | частично: сообщение уходит только пригласившему (`referral_payout_message`), покупателю о своём кэшбеке — нет |
| loyalty-tasks | sep | нет; отзывы с фото и модерацией есть (`models/review.py`), баллов за них нет |
| trade-in-photo | sep | нет; есть только `manager_tradein_url` |
| delivery-track | oct | нет — вне этого объёма |

Правило отметки: `done: true` — только то, что выехало на прод и работает.

---

## Поток A. Фото-ИИ: «Найти по фото» и Trade-In по фото

### Общий механизм — `services/ai_vision.py`

- Модель — та же `AI_ANTHROPIC_MODEL` (Claude Haiku 4.5 умеет изображения),
  транспорт — тот же клиент `ai_anthropic` (гейтвей `AI_ANTHROPIC_BASE_URL`,
  прокси `AI_GATEWAY_PROXY_URL`). Изображение — base64 content-block.
- `identify_device(image_bytes, media_type, purpose) -> DeviceGuess`:
  `{brand, model, generation, storage, color, condition_grade, confidence,
  visible_defects: list[str]}`. Строгий JSON по схеме, разбор с валидацией;
  мусор/низкая уверенность → `confidence="low"`, не исключение.
- **Модель НЕ называет денег.** Только что на фото и в каком состоянии.
  Деньги считает backend из нашей базы (тот же инвариант, что у чата:
  «цены только из БД»).
- Доступность: только при `AI_PROVIDER=anthropic`. Иначе эндпоинты отвечают
  503, а `/api/config` отдаёт `photo_ai_enabled=false` — фронт прячет входы.
- Размер: фронт ужимает картинку до ≤1280 px по длинной стороне, JPEG ~0.8
  (гейтвей на Vercel режет тела > 4.5 МБ). Backend отвергает > 5 МБ (413) и
  не-изображения (415).
- Лимит: отдельный per-user лимит `AI_PHOTO_RATE_LIMIT_PER_MINUTE` (5) по
  образцу лимита чата.
- Фото для ПОИСКА не сохраняется (только в памяти запроса). Фото для
  Trade-In сохраняется тем же загрузчиком, что «Продать своё» — его смотрит
  менеджер.
- Логи: без содержимого изображения и без base64.

### A1. «Найти по фото»

- `POST /api/ai/photo-search` (multipart `image`) → `identify_device` →
  текстовый запрос из `brand model generation storage` → существующий
  `retrieve_candidates` (с новизной и релевантностью) → ответ
  `{guess, query, cards, meta}`; карточки — через `to_card`, как в чате.
- Ничего не нашли / низкая уверенность: честный текст «Не узнал устройство —
  попробуйте фото крупнее или напишите модель» + кнопка в чат с `query`.
- Фронт: кнопка-камера в строке поиска (`lib/searchRoutes.ts` — маршруты
  строки поиска общие для главной, каталога и desktop-шапки) и на экране `/ai`.
  Выбор файла через `<input type=file accept="image/*" capture>`. Результат —
  экран `/ai` с ходом «📷 Фото» и найденными карточками (переиспользовать
  рендер `Turn`), либо отдельная страница — на усмотрение исполнителя, но без
  второго рендера карточек.
- Аналитика: `photo_search_submitted`, `photo_search_result {found: bool}` —
  в оба allowlist (фронт `analytics.ts`, backend `schemas/ai.py`).

### A2. Trade-In с оценкой по фото (роудмап `trade-in-photo`)

- Страница `/trade-in`: 1–3 фото устройства → «Оценить» → результат:
  распознанная модель, состояние, замеченные дефекты, **вилка цены** с
  подписью «предварительно, точную сумму назовёт менеджер при осмотре; её
  можно зачесть в счёт покупки» → «Отправить менеджеру» (телефон
  опционально, как в «Продать своё»).
- Вилка (backend, `services/trade_in.py`): база = минимальная цена активного
  товара в наличии ТОЙ ЖЕ модели (`novelty.model_key`) в состоянии `new`;
  вилка = база × [низ, верх] по `condition_grade`:
  - `excellent` 55–65 %, `good` 45–55 %, `fair` 30–40 % — значения по
    умолчанию, редактируются в админке (новая таблица `trade_in_settings`
    одной строкой по образцу `loyalty_settings`, раздел в админских
    настройках).
  - Округление вниз до 500 ₽. Модели нет в каталоге или `confidence=low` —
    вилки нет: «оценит менеджер по фото», заявка всё равно уходит.
- Заявка: `Lead` с источником/типом `trade_in` (посмотреть, как
  `sell_item` создаёт лид и уведомление менеджеру — `sell_item_message`),
  в админке видна в «Заявках» с фото, моделью, состоянием и вилкой.
- Входы: профиль и `/info` (где сейчас ссылка на менеджера по Trade-In),
  кнопка «Оценить своё по фото» в карточке товара НЕ нужна — YAGNI.
- `manager_tradein_url` остаётся запасным путём при `photo_ai_enabled=false`.
- Аналитика: `trade_in_estimated {has_range}`, `trade_in_submitted`.

---

## Поток B. Хвосты роудмапа

### B1. Маршрут к точке выдачи (`pickup-point`)

- `lib/pickup.ts`: `PICKUP_MAP_URL` — поиск Яндекс Карт по `PICKUP_ADDRESS`
  (`https://yandex.ru/maps/?text=<encodeURIComponent>`). Точного адреса в коде
  нет — не выдумывать, искать по «Горбушка, Москва».
- Ссылка «Маршрут» — в заявке с самовывозом (`pages/Requests.tsx`) и в
  корзине при выборе самовывоза. Открывать через `openExternalLink`.
- `roadmap.ts`: `pickup-point` → `done`.

### B2. Уведомление о начислении кэшбека (`points-notify`)

- При начислении кэшбека по факту покупки (`services/purchase.py` /
  `loyalty.py` — найти точку начисления) — `enqueue()` ТОЙ ЖЕ транзакцией,
  `dedupe_key="cashback:{lead_id}"`, kind `cashback_accrued`.
- Текст: «Начислено N баллов за покупку. На счету M — в корзине ими можно
  оплатить до 5 % заказа» (процент из `redeem_max_bps`). Кнопка «💎 Мои
  баллы» → `/loyalty` (как в `referral_payout_message`).
- Откат начисления (уход заявки из «завершена») уведомления не шлёт.
- `roadmap.ts`: `points-notify` → `done`.

### B3. Задания за баллы (`loyalty-tasks`)

- Баллы за одобренный отзыв о покупке: при переходе отзыва в `approved`
  (модерация в админке) — начисление `review_bonus_points` (по умолчанию
  200), +`review_photo_bonus_points` (по умолчанию 200) если есть фото
  («фото распаковки»). Один раз на отзыв (идемпотентно по `review.id`),
  повторное одобрение не начисляет. Отзыв без заявки (`lead_id` NULL) — без
  баллов. Операция в журнале баллов с понятной причиной; уведомление через
  outbox.
- Настройки — две колонки в `loyalty_settings` + поля в админке рядом с
  остальными настройками лояльности. Мини-миграция в `main.py`; если колонки
  читает бот — `REQUIRED_SCHEMA` в `bot_polling.py`.
- Экран `/loyalty`: блок «Задания» — «Отзыв о покупке +200», «Фото
  распаковки +200», «Пригласить друга» (ведёт в существующий реферальный
  блок). Числа — с backend (`/loyalty/me` или соседний эндпоинт), не
  константы во фронте.
- `roadmap.ts`: `loyalty-tasks` → `done`.

### B4. Отметить сделанное

- `price-tracker` → `done` (комментарий: favorite_watch, с 1.1).
- `ai-compare` → `done` (CompareTable в чате).

`trade-in-photo` отмечает интегратор после потока A.

---

## Владение файлами (потоки идут в одном дереве параллельно)

| | поток A | поток B |
|---|---|---|
| backend | `services/ai_vision.py`, `services/trade_in.py`, `api/ai.py` (новые эндпоинты), `api/trade_in.py`, модель `trade_in_settings`, `schemas/ai.py` | `services/purchase.py`, `loyalty.py`, `reviews`/`admin_crm` модерация, `notification_templates.py`, `notifications.py`, `models/loyalty_settings.py` |
| общие | `main.py`, `bot_polling.py`, `api/config.py`, `admin/src` (свой раздел) — **перечитать файл непосредственно перед правкой, правки точечные** | то же |
| frontend | `lib/photo*`, `lib/tradeIn*`, `pages/TradeIn.tsx`, `pages/AiSearch.tsx`, `lib/searchRoutes.ts`, `components/Search*`, `lib/analytics.ts`, роут в `App`/router | `lib/pickup.ts`, `pages/Requests.tsx`, `pages/Cart.tsx`, `pages/Loyalty.tsx`, `lib/roadmap.ts` |

Никто не коммитит и не деплоит — интегратор.

## Проверки

```
cd backend && python -m pytest -q
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
cd admin && npx tsc --noEmit && npm run build
```

После деплоя на проде: реальный вызов `identify_device` через гейтвей с
тестовым фото (проходит ли картинка через гейтвей — главный риск); вилка
Trade-In для iPhone 17 Pro. **На живом телефоне в Telegram не проверено**:
камера/выбор файла внутри webview, ужатие фото, ссылка маршрута.

## Вне объёма

- `delivery-track` (трек-номер и статусы доставки).
- Раздел «Что нового» и пост в канал о сделанном.
- Автопост новинок в канал.
