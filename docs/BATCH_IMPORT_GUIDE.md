# Batch Import Center (v5.2): пакетный импорт товаров и фото

Один drag-and-drop — несколько CSV/XLSX/JSON + ZIP с фото (или единый Import Pack),
общий preview, подтверждение, применение ровно того пакета, который проверили.

## Рабочий процесс (безопасный)
1. **Собери файлы**: прайсы (.csv/.xlsx/.json) и/или ZIP с фото. Или один Import Pack ZIP.
2. Админка → вкладка **Импорт** → перетащи всё в зону загрузки (файлы можно удалять из списка).
3. Выбери режим (`создавать и обновлять` / `только обновлять` / `только создавать`)
   и политику дублей (по умолчанию дубль SKU между файлами = ошибка).
4. **«Проверить пакет»** — сервер создаёт import job и показывает отчёт.
   БД не меняется, фото никуда не сохраняются.
5. Изучи отчёт: summary, отчёты по файлам, таблица строк (фильтры: ошибки/warnings/
   create/update/без изменений; поиск по SKU; diff `price: 67 500 → 67 000`),
   несматченные фото, товары без фото. Ошибки можно скачать CSV.
6. **«Применить пакет»** — обязательное подтверждение «Импортировать N товаров и M изображений».
   Кнопка заблокирована, пока в пакете есть ошибки.
7. Успех: job id + итоговый report. Или **«Отменить job»** — файлы удаляются сразу.

## Жизненный цикл job
- `preview` → job со статусом `previewed`, **TTL 30 минут** (`IMPORT_JOB_TTL_SECONDS`).
- Confirm применяет именно previewed-план: новые файлы не принимаются,
  SHA-256 staged-файлов сверяется.
- Confirm одноразовый; повторный — идемпотентный ответ с тем же результатом.
- Job принадлежит админу, создавшему её; чужие job невидимы (404).
- По истечении TTL job и её файлы удаляются; applied-job хранит только report (сутки).

## Гарантии применения
- Товары применяются **одной транзакцией**: сбой в середине = БД не изменена (409).
- Фото сохраняются в постоянное хранилище только после успешной товарной транзакции.
- Ошибка отдельного фото не откатывает товары, но попадает в report,
  и ответ помечается `partial: true` — частичный успех не маскируется.
- Отсутствующие в файлах товары никогда не удаляются и не деактивируются.

## Семантика обновления (изменена в v5.2!)
Для **существующего SKU** пустое поле = «не менять»:
- пустой `stock` больше НЕ обнуляет остаток;
- пустой `is_active` больше НЕ включает выключенный товар.
Явные значения применяются: `stock=0` обнулит, `is_active=false` выключит.
Для **нового** товара: пустой stock = 0, пустой is_active = true; обязательны `title` и `price`.

## Import Pack ZIP
```
AI_SELLER_IMPORT_PACK.zip
├── products/            # 01_iphone.csv, 02_macbook.xlsx, 03_dyson.json
├── images/              # APL-IP17-256-BLK-IN_main.webp, ...
├── manifest.json        # опционально: {"version":1,"mode":"create_or_update","duplicate_policy":"error"}
└── README.txt           # игнорируется (info)
```
manifest может переопределить mode/duplicate_policy пакета. Неизвестные файлы — info.

## Фото
Именование прежнее (см. IMAGE_NAMING_GUIDE.md): `SKU_main.webp`, `SKU-1.webp`, `SKU_2.png`.
Главная: `_main`/`-main` → файл без суффикса → `-1`, `-2`…
Матчинг в preview: существующие SKU **и SKU, создаваемые этой же job**.

## Лимиты (env)
```
IMPORT_MAX_FILES=30                    # файлов в пакете
IMPORT_MAX_TOTAL_ROWS=5000             # строк суммарно
IMPORT_MAX_DATA_FILE_BYTES=20971520    # 20 МБ на data-файл
IMPORT_MAX_ZIP_BYTES=524288000         # 500 МБ на ZIP
IMPORT_MAX_UNCOMPRESSED_BYTES=1073741824  # 1 ГБ распакованного
IMPORT_JOB_TTL_SECONDS=1800            # 30 минут
IMPORT_MAX_IMAGES=5000                 # изображений в пакете
IMPORT_PRICE_CHANGE_WARN_PCT=30        # warning при изменении цены > N%
```
Изображение ≤ 8 МБ. Защита ZIP: zip-slip, абсолютные пути, symlink, bomb
(включая ложный размер в заголовке), ложный MIME (по магическим байтам),
дубли имён, `__MACOSX`/скрытые файлы.

## Алиасы заголовков (детерминированные, без LLM)
`артикул→sku, название/наименование→title, цена→price, старая цена→old_price,
остаток/количество→stock, бренд→brand, категория→category, описание→description,
состояние→condition, цвет→color, память→memory, накопитель→storage, гарантия→warranty_months`.
Применённые алиасы и неизвестные колонки видны в отчёте (info).

## API (curl)
```bash
TOKEN=$(curl -s -X POST $BASE/api/auth/admin/login -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}' | jq -r .access_token)

# preview: несколько файлов
curl -s -X POST "$BASE/api/admin/import/batch/preview" \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@01_iphone.csv" -F "files=@02_macbook.xlsx" -F "files=@photos.zip" \
  -F "mode=create_or_update" -F "duplicate_policy=error" | jq .summary
# -> {"job_id": "...", ...}

curl -s "$BASE/api/admin/import/batch/<job_id>" -H "Authorization: Bearer $TOKEN"        # статус
curl -s -X POST "$BASE/api/admin/import/batch/<job_id>/confirm" -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE "$BASE/api/admin/import/batch/<job_id>" -H "Authorization: Bearer $TOKEN"  # отмена
```

## Rollback
- До confirm: «Отменить job» или подождать TTL — БД не тронута.
- Confirm упал: транзакция откатилась сама, БД не изменена.
- После успешного confirm: восстановление из pg_dump-бэкапа
  (update-server.sh делает его перед каждым деплоем; вручную: `/opt/backups`).
- Старые endpoints `/api/admin/import/products/preview|confirm` и
  `/api/admin/uploads/products/images-zip` работают как раньше.
