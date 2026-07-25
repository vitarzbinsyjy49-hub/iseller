# Rocketniks photo collector — операторский гайд

Оффлайн-инструмент, который **находит и готовит** фото товаров для SKU без снимков,
используя **официальный Rocketniks Public API** (не скрейпинг), и собирает ZIP для
существующего импорта «Медиа → ZIP с фото товаров». Ничего не импортирует в БД сам,
ничего не хотлинкит, не трогает прод.

Пакет: `scripts/rocketniks/` · тесты: `scripts/rocketniks/tests/` · вывод:
`artifacts/rocketniks/<дата>/` (в `.gitignore`).

## Схема

```
review_queue.csv (SKU без фото)
        │  --discover
        ▼
Rocketniks Public API  ──►  матчер (score + конфликты)  ──►  matches.json + CSV/HTML отчёты
        │  (подтверждение человеком в отчёте/preview.html)
        ▼  --download  (только exact/likely, скачивание ТОЛЬКО после этого шага)
валидация (HTTP/MIME/сигнатура/разрешение/SHA-256/дедуп)  ──►  SKU-именованный ZIP + manifest
        ▼
Админка → Медиа → «ZIP с фото товаров»  (штатный импорт, заменяет галерею по SKU)
```

## Что собирает API (read-only)

- `GET /api/search?query=` — поиск (по точному `vendorCode` = 1 хит; по названию = ≤20 кандидатов).
- `GET /api/products/{url-slug}` — detail: `vendorCode`, `brand`, структурный `color`,
  `vartiantImages` (**цветоспецифичные** фото), `images` (общий пул модели),
  `propertiesGroups` (specs), `variantsLinks` (варианты).
- Цены/наличие/акции Rocketniks **НЕ** импортируются.

## Матчинг (детерминированный)

Веса: артикул 50 · модель/поколение 25 · цвет 15 · размер 5 · конфигурация 5.
Статус определяется **полнотой совпадения + конфликтами**, а не только суммой баллов
(у Dyson и синтетических SKU артикул не совпадает, но модель+цвет+размер полностью
определяют галерею):

| Статус | Значение |
|---|---|
| `exact` | артикул совпал + цвет + без конфликтов |
| `likely` | модель+цвет совпали, без конфликтов (артикул мог не совпасть) |
| `review` | мягкий конфликт (год/ANC), цвет неоднозначен, или неполнота — решает человек |
| `rejected` | жёсткий конфликт: цвет / размер / поколение / код устройства / семейство |
| `not_found` | кандидатов нет |

**Жёсткий конфликт запрещает авто-применение** (никогда не exact/likely). Цвет с
кириллическими гомоглифами (`Bluе` с кир. `е`) нормализуется; многоцветные наборы с
разным основным цветом (apricot vs blue-blush при общем topaz) уходят в review.

## Цветовые галереи (ЧАСТЬ 4: разные цвета — разные галереи)

Rocketniks отдаёт ОДИН пул `images` на модель. Инструмент берёт **свои `vartiantImages`
(цветовые герои) + только те кадры пула, что НЕ являются героем другого цвета**
(нейтральные детальные снимки). Главная (`images[0]`) — всегда цветокорректный герой,
поэтому карточка товара показывает правильный цвет. ⚠️ Нейтральные детальные кадры берутся
из общего пула модели — их стоит бегло глянуть в `preview.html` перед импортом.

## Запуск

```bash
# 1) discovery + отчёты (сеть; фото НЕ скачиваются)
python -m scripts.rocketniks.collector --discover --out artifacts/rocketniks/2026-07-24

# пилот на нескольких SKU
python -m scripts.rocketniks.collector --discover --sku MW1L3 --sku DYS-HD16-CER-PNK-CN

# 2) посмотреть preview.html / rocketniks_matches.csv, отклонить лишнее
#    (правьте колонку approval в rocketniks_matches.csv при необходимости)

# 3) скачать фото approved-строк и собрать ZIP (exact+likely)
python -m scripts.rocketniks.collector --download --out artifacts/rocketniks/2026-07-24
python -m scripts.rocketniks.collector --download --dry-run   # проверить без записи

# 4) залить artifacts/.../AI_SELLER_ROCKETNIKS_VERIFIED.zip через Админку → Медиа
```

Флаги: `--limit N`, `--sku S` (повторяемый), `--resume` (кэш + пропуск готовых),
`--report` (перегенерировать отчёты из matches.json), `--cache DIR`.

## Выходные файлы (`artifacts/rocketniks/<дата>/`)

`matches.json` · `rocketniks_matches.csv` · `no_photos.csv` · `needs_review.csv` ·
`ready.csv` · `product_data.csv/json` · `image_manifest.csv` · `report.md` ·
`preview.html` · `AI_SELLER_ROCKETNIKS_VERIFIED.zip` · `logs/api_errors.json`.

`image_manifest.csv`: sku, visual_group_id, file_name, sha256, width, height, mime_type,
source_page_url, source_image_url, match_score, approval_status.

## Именование ZIP (как в IMAGE_NAMING_GUIDE.md)

`SKU.ext` — главная; `SKU-1.ext`, `SKU-2.ext`… — галерея (до 10). Импорт матчит по имени
файла = SKU (регистронезависимо) и **заменяет** галерею товара целиком.

## Безопасность

- Только admin-инструмент оператора; **прод не трогается**, БД не пишется автоматически.
- Фото **скачиваются на наш сервер**, внешние URL не сохраняются в карточки (нет hotlink).
- Скачивание — только на шаге `--download` для approved/exact/likely; `review`/`rejected` не скачиваются.
- Валидация каждого файла: HTTP 200, Content-Type image, сигнатура (Pillow), мин. сторона
  ≥400px (отсев thumbnails/иконок), SHA-256 дедуп внутри товара, лимит 10.
- API-ключ читается из `ROCKETNIKS_API_KEY`, в логи не печатается.
- Щадящая частота: задержка между запросами API и между скачиваниями фото, локальный кэш, resume.

## Тесты

```bash
python -m pytest scripts/rocketniks/tests -q
```
Покрывают: нормализацию/цвета (RU↔EN, гомоглифы), visual grouping, конфликты
поколения/цвета/размера, ANC, Dyson-код, лимит 10, SHA-дедуп, ZIP-именование, кэш/resume,
dry-run без скачивания, защиту approval-гейта.
