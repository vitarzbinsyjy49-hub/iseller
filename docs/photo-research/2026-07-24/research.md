# Research недостающих фотографий — 2026-07-24

Дата: 2026-07-24 · Метод: WebSearch/WebFetch по **официальным** доменам производителей.

## Что это

Демонстрация политики research официальных источников на **канонических моделях**,
которые присутствуют в каталоге AI Seller (Apple iPhone/MacBook, Dyson). Research
ведётся **на canonical `image_group_key`** (модель+цвет), а не на каждый SKU/память.

> **Важно (см. §11 задания):** доступа к продовой БД (218 товаров на VPS) из этой
> среды нет. Поэтому реальный приоритетный список недостающих групп нужно получить,
> запустив read-only аудит против прод-данных:
> `DATABASE_URL=<prod-replica-or-dump> python scripts/photo_coverage_audit.py`
> — затем прогнать research по строкам `coverage.csv` с `research_status=unresolved`.
> Ничего не выдумано: ниже — только реально найденные официальные страницы.

## Политика источников (соблюдена)

1. Приоритет — официальный сайт производителя / его newsroom / press / media kit.
2. **НЕ** маркетплейсы, объявления, водяные знаки, пользовательские фото, неизвестные CDN.
3. **Не hotlink-им** внешние изображения в прод-каталог.
4. **Не** записываем внешние candidate URL в Product автоматически.
5. **Ничего не скачано и не закоммичено** в этом патче — только ссылки-источники.
6. Один research на canonical `image_group_key`.

## Статусы

- `verified` — официальный источник найден и однозначно соответствует модели.
- `needs_review` — источник официальный, но выбор конкретных цветовых ассетов и
  проверка условий использования (brand guidelines/press terms) требуют ручного
  подтверждения перед любой загрузкой.
- `unresolved` — официальный источник не найден / нет доступа к интернету.

## Найдено (официальные страницы-источники)

| Модель (группа) | Цвет | Источник (официальный) | Домен | Соответствие | Confidence | Статус |
|---|---|---|---|---|---|---|
| iPhone 15 Pro | (все титановые) | https://support.apple.com/en-us/111829 | support.apple.com | модель точная | high | needs_review |
| iPhone 15 Pro Max | (все титановые) | https://support.apple.com/en-us/111828 | support.apple.com | модель точная | high | needs_review |
| iPhone 15 | (все) | https://support.apple.com/en-us/111831 | support.apple.com | модель точная | high | needs_review |
| MacBook Pro 14 M3 | Space Gray / Silver | https://support.apple.com/en-us/117735 | support.apple.com | модель точная | high | needs_review |
| MacBook Pro 14 M3 Pro/Max | Space Black / Silver | https://support.apple.com/en-us/117736 | support.apple.com | модель точная | high | needs_review |
| MacBook Pro 14 (общая) | — | https://www.apple.com/macbook-pro/specs/ | apple.com | семейство | medium | needs_review |
| MacBook Pro M3 (анонс/press) | — | https://www.apple.com/newsroom/2023/10/apple-unveils-new-macbook-pro-featuring-m3-chips/ | apple.com (newsroom) | press-ассеты | medium | needs_review |
| Dyson Supersonic | Nickel/Copper и др. | https://www.dyson.com/hair-care/hair-dryers/supersonic | dyson.com | модель точная | high | needs_review |
| Dyson Supersonic Origin | Nickel/Copper | https://www.dyson.com/hair-care/hair-dryers/supersonic/origin-nickel-copper | dyson.com | модель+цвет | high | needs_review |

## Почему `needs_review`, а не `verified` для ассетов

Страницы-источники официальные и однозначно соответствуют моделям. Но:
- на них нужно **вручную** выбрать конкретный цветовой ассет под нужный
  `image_group_key` (цвет группы), а не «первую попавшуюся» картинку;
- использование фото/press-ассетов Apple/Dyson регулируется их brand guidelines;
  перед загрузкой в прод это должен подтвердить человек (правовая проверка).

Поэтому патч **не скачивает и не подставляет** эти изображения автоматически. Это
осознанное ограничение (см. §11 п.6–7, §17): «не публиковать найденные фото в прод
без отдельного подтверждения».

## Как продолжить (реальный прод)

1. Получить read-only срез прод-БД (реплика или дамп) и запустить
   `scripts/photo_coverage_audit.py` → `coverage.csv`.
2. Отсортировать по `priority` (P0 → P1) и `missing_to_target`.
3. Для каждой canonical-группы найти официальную страницу (как выше), занести
   `source_page_url`/`source_domain`/`confidence`/`research_status` в `coverage.csv`.
4. Скачивание/подстановку фото делать **отдельным** шагом после ручного approve —
   через существующий импорт групп (`/api/admin/import/image-groups/*`), не хардкодом.
