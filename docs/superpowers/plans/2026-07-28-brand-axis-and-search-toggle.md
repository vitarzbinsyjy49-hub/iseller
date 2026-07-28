# Ось «Бренды» и тумблер «Каталог / AI» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Навигацию на главной можно переключать между категориями и брендами, а строку поиска — между поиском по каталогу и AI-подбором.

**Architecture:** Бэкенд получает вторую ось навигации (`list_brands()` в `catalog_nav`, ключ `brands` в ответе `GET /home`) по тем же правилам, что уже действуют для категорий: за плиткой обязаны быть товары, некурируемый бренд добавляется сам, выключенная плитка не воскресает. Фронт выносит решающую логику в чистые функции (`searchRoute`, `navTiles`), потому что vitest в этом проекте работает без DOM, и добавляет один переиспользуемый компонент `SegmentedToggle` на оба тумблера.

**Tech Stack:** FastAPI + SQLAlchemy + pytest (backend), React 18 + TypeScript + Vite + vitest в окружении node (frontend), React + Vite (admin).

**Спека:** `docs/superpowers/specs/2026-07-28-brand-axis-and-search-toggle-design.md`

---

## Важный контекст для исполнителя

- Работаем в `C:/iseller-demo`, ветка `master`. Каталоги `ISELLER/work/`, `ISELLER/_extract/` не трогать.
- Правил фронт → перезапусти контейнер, Vite не видит правки через bind-mount на Windows:
  `docker compose -f docker-compose.demo.yml restart frontend`
- Правил `.env` или `requirements.txt` → пересоздай контейнер:
  `docker compose -f docker-compose.demo.yml up -d --build backend`
- Тесты фронта — **только чистые функции**: `vitest.config.ts` собирает `src/**/*.test.ts`, окружение `node`, DOM нет. Не добавляй jsdom и testing-library.
- Тесты бэкенда используют sqlite in-memory и фикстуры из `backend/tests/conftest.py` (`db`, `make_product`). Фикстура `client` с подменой авторизации уже есть в `backend/tests/test_catalog_nav.py`.
- Комментарии в коде проекта — по-русски и объясняют «почему», а не «что». Держись этого стиля.

---

## Файловая структура

**Backend**

| файл | ответственность | что делаем |
|---|---|---|
| `backend/app/services/catalog_nav.py` | чистая навигация из данных | + `BRAND_ICONS`, `brand_icon()`, `list_brands()` |
| `backend/app/api/home.py` | сборка ответа главной | + вторая ось в `GET /home`, вынос сборки авто-плитки в `_auto_tile()` |
| `backend/tests/test_catalog_nav.py` | правила видимости навигации | + тесты на `list_brands()` и ось брендов в `/home` |

**Frontend**

| файл | ответственность | что делаем |
|---|---|---|
| `frontend/src/lib/route.ts` | безопасные маршруты | + `actionRoute()` переезжает сюда из `Home.tsx` |
| `frontend/src/lib/searchMode.ts` | режим строки поиска | создаём: тип `SearchMode`, `searchRoute()` |
| `frontend/src/lib/navTiles.ts` | чипы навигации по осям | создаём: тип `NavAxis`, `navTiles()` |
| `frontend/src/components/SegmentedToggle.tsx` | переключатель на два положения | создаём, используем дважды |
| `frontend/src/pages/Home.tsx` | главная | тумблер оси над hero-чипами, тумблер режима в поиске, общий `axis` в сайдбар |
| `frontend/src/components/DesktopHeader.tsx` | desktop-шапка | тумблер режима в строке поиска |

**Admin**

| файл | что делаем |
|---|---|
| `admin/src/HomeAdmin.tsx` | `brand: "Бренд"` в `ACTION_LABELS` |

---

### Task 1: `list_brands()` в catalog_nav

**Files:**
- Modify: `backend/app/services/catalog_nav.py`
- Test: `backend/tests/test_catalog_nav.py`

- [ ] **Step 1: Написать падающие тесты**

Добавь в конец секции про категории в `backend/tests/test_catalog_nav.py` (перед секцией про `has_products`), и добавь `brand_icon`, `list_brands` в существующий импорт из `app.services.catalog_nav`:

```python
# ---------- бренды: та же ось навигации, тот же источник правды ----------

def test_empty_catalog_has_no_brands(db):
    assert list_brands(db) == []


def test_only_brands_with_active_products(db):
    make_product(db, brand="Apple")
    make_product(db, brand="Sony", category="консоли", is_active=False)
    assert [b["key"] for b in list_brands(db)] == ["Apple"]


def test_brands_order_biggest_first_then_name(db):
    make_product(db, brand="Dyson", category="красота")
    make_product(db, brand="Dyson", category="бытовая техника")
    make_product(db, brand="Apple")
    make_product(db, brand="Sony", category="консоли")
    # Dyson 2 товара -> первый; Apple и Sony по одному -> по алфавиту
    assert [b["key"] for b in list_brands(db)] == ["Dyson", "Apple", "Sony"]


def test_brand_key_keeps_original_case(db):
    make_product(db, brand="Dyson", category="красота")
    # ?brand= сравнивает точным равенством: нормализация ключа сломала бы переход
    assert list_brands(db)[0]["key"] == "Dyson"
    assert list_brands(db)[0]["label"] == "Dyson"


def test_known_brand_gets_its_icon(db):
    make_product(db, brand="Dyson", category="красота")
    assert list_brands(db)[0]["icon"] == BRAND_ICONS["dyson"]


def test_unknown_brand_gets_fallback_icon_but_stays_in_nav(db):
    make_product(db, brand="Zanussi", category="бытовая техника")
    brands = list_brands(db)
    assert [b["key"] for b in brands] == ["Zanussi"]
    assert brands[0]["icon"] == FALLBACK_ICON


def test_brand_counts_are_real(db):
    make_product(db, brand="Dyson", category="красота")
    make_product(db, brand="Dyson", category="бытовая техника")
    assert list_brands(db)[0]["count"] == 2
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && python -m pytest tests/test_catalog_nav.py -k brand -q`
Expected: FAIL — `ImportError: cannot import name 'list_brands' from 'app.services.catalog_nav'`

- [ ] **Step 3: Реализовать**

В `backend/app/services/catalog_nav.py` сразу после `FALLBACK_ICON`/`SALE_ICON`/`SALE_LABEL` добавь словарь:

```python
# Оформление известных брендов. Это НЕ список брендов — только внешний вид для
# тех, что реально есть в каталоге: незнакомый бренд попадает в навигацию и без
# записи здесь, просто с нейтральной иконкой.
BRAND_ICONS: dict[str, str] = {
    "apple": "🍏",
    "dyson": "🌀",
    "sony": "🎮",
}
```

И после `list_categories()` добавь:

```python
def brand_icon(raw: str) -> str:
    return BRAND_ICONS.get((raw or "").strip().lower(), FALLBACK_ICON)


def list_brands(db: Session) -> list[dict]:
    """Бренды для навигации: только непустые, крупные первыми.

    Зеркало list_categories(). Ключ — значение Product.brand как оно лежит в
    БД: фильтр `?brand=` сравнивает точным равенством, поэтому нормализация
    ключа увела бы плитку в пустой каталог. Подпись — тот же ключ: у брендов
    собственный регистр («iPhone» пишется не так, как «бытовая техника»), и
    category_label() здесь только испортил бы имя.

    Виртуальной записи вроде SALE_KEY у брендов нет — скидка не бренд.
    """
    counts = brand_counts(db)
    return [
        {"key": key, "label": key, "icon": brand_icon(key), "count": n}
        for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd backend && python -m pytest tests/test_catalog_nav.py -q`
Expected: PASS, все тесты файла зелёные

- [ ] **Step 5: Коммит**

```bash
git add backend/app/services/catalog_nav.py backend/tests/test_catalog_nav.py
git commit -m "feat(catalog): бренды как вторая ось навигации из данных"
```

---

### Task 2: вторая ось в `GET /home`

**Files:**
- Modify: `backend/app/api/home.py:25-60`
- Test: `backend/tests/test_catalog_nav.py`

- [ ] **Step 1: Написать падающие тесты**

Добавь в `backend/tests/test_catalog_nav.py` после существующих тестов про `/home`:

```python
# ---------- /home: две оси навигации ----------

def test_home_returns_brand_axis_from_catalog(client, db):
    make_product(db, brand="Dyson", category="красота")
    make_product(db, brand="Dyson", category="бытовая техника")
    body = client.get("/api/home").json()
    assert [b["action_value"] for b in body["brands"]] == ["Dyson"]
    assert all(b["action_type"] == "brand" for b in body["brands"])


def test_home_brand_axis_is_empty_without_products(client, db):
    body = client.get("/api/home").json()
    assert body["brands"] == []


def test_home_hides_brand_tile_without_products(client, db):
    make_product(db, brand="Apple")
    db.add(HomeCategory(title="Dyson", action_type="brand", action_value="Dyson",
                        position=1, is_active=True))
    db.commit()
    body = client.get("/api/home").json()
    # Курируемая плитка бренда, у которого нет товаров, на главную не выходит
    assert [b["action_value"] for b in body["brands"]] == ["Apple"]


def test_home_respects_explicitly_disabled_brand_tile(client, db):
    make_product(db, brand="Dyson", category="красота")
    db.add(HomeCategory(title="Dyson", action_type="brand", action_value="Dyson",
                        position=1, is_active=False))
    db.commit()
    body = client.get("/api/home").json()
    # Выключенная плитка — осознанное «скрыть», автодобавление её не воскрешает
    assert body["brands"] == []


def test_home_does_not_duplicate_curated_brand(client, db):
    make_product(db, brand="Dyson", category="красота")
    db.add(HomeCategory(title="Дайсон", emoji="🌀", action_type="brand",
                        action_value="Dyson", position=1, is_active=True))
    db.commit()
    body = client.get("/api/home").json()
    assert [b["action_value"] for b in body["brands"]] == ["Dyson"]
    assert body["brands"][0]["title"] == "Дайсон"   # оформление админа сохраняется


def test_brand_tile_does_not_leak_into_category_axis(client, db):
    make_product(db, brand="Dyson", category="красота")
    db.add(HomeCategory(title="Dyson", action_type="brand", action_value="Dyson",
                        position=1, is_active=True))
    db.commit()
    body = client.get("/api/home").json()
    assert all(c["action_type"] != "brand" for c in body["categories"])


def test_uncountable_tiles_stay_on_category_axis(client, db):
    make_product(db, brand="Apple")
    db.add(HomeCategory(title="Спросить AI", action_type="ai", action_value="",
                        position=1, is_active=True))
    db.commit()
    body = client.get("/api/home").json()
    # Поиск/подборка/AI не переезжают на ось брендов и не образуют третью ось
    assert "Спросить AI" in [c["title"] for c in body["categories"]]
    assert "Спросить AI" not in [b["title"] for b in body["brands"]]
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && python -m pytest tests/test_catalog_nav.py -k "brand_axis or brand_tile or uncountable or disabled_brand or curated_brand" -q`
Expected: FAIL — `KeyError: 'brands'`

- [ ] **Step 3: Реализовать**

В `backend/app/api/home.py` расширь импорт:

```python
from app.services.catalog_nav import (
    brand_counts, category_counts, has_products, list_brands, list_categories, sale_count,
)
```

Добавь перед `get_home` вспомогательную функцию:

```python
def _auto_tile(item: dict, *, action_type: str, index: int,
               id_offset: int, position_base: int) -> dict:
    """Плитка, которой админ ещё не занимался, — собирается из данных каталога.

    id отрицательный и разведён по осям смещением: он используется только как
    React-ключ на фронте и не должен совпадать у категории и бренда."""
    return {
        "id": -(id_offset + index + 1), "title": item["label"], "emoji": item["icon"],
        "icon_url": None, "background_gradient": None,
        "action_type": action_type, "action_value": item["key"],
        "position": position_base + index, "is_active": True,
    }
```

Замени тело `get_home` начиная со строки со счётчиками и до `return`:

```python
    # Счётчики — один раз на запрос, а не на плитку.
    cats, brands, sale = category_counts(db), brand_counts(db), sale_count(db)

    # Плитка, за которой нет товаров, на главную не выходит: пустой экран после
    # нажатия хуже отсутствующей плитки. Скрываем только посчитанное
    # (категория/бренд) — поиск, подборки и AI не трогаем.
    def shown(rows: list[HomeCategory]) -> list[dict]:
        return [c.to_dict() for c in rows
                if c.is_active
                and has_products(c.action_type, c.action_value,
                                 categories=cats, brands=brands, sale=sale)]

    # Две оси навигации: бренды отдельной вкладкой, всё остальное — включая
    # непосчитаемые промо-плитки (поиск, подборка, AI) — на оси категорий.
    # Третьей корзины нет намеренно: промо некуда переезжать.
    managed_brands = [c for c in managed if c.action_type == "brand"]
    managed_rest = [c for c in managed if c.action_type != "brand"]

    # Категория, которой админ ещё не занимался, показывается сама. Так новый
    # раздел (импорт прайса, товар из админки) появляется в навигации без
    # правок кода и без ручного создания плитки.
    curated_cats = {(c.action_value or "").strip() for c in managed if c.action_type == "category"}
    categories = shown(managed_rest) + [
        _auto_tile(c, action_type="category", index=i, id_offset=0, position_base=1000)
        for i, c in enumerate(c for c in list_categories(db) if c["key"] not in curated_cats)
    ]

    curated_brands = {(c.action_value or "").strip() for c in managed_brands}
    brand_tiles = shown(managed_brands) + [
        _auto_tile(b, action_type="brand", index=i, id_offset=1000, position_base=2000)
        for i, b in enumerate(b for b in list_brands(db) if b["key"] not in curated_brands)
    ]

    return {
        "banners": [b.to_dict() for b in banners],
        "categories": categories,
        "brands": brand_tiles,
    }
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd backend && python -m pytest tests/test_catalog_nav.py -q`
Expected: PASS. Отдельно проверь, что старые тесты оси категорий не сломались — они в том же файле.

- [ ] **Step 5: Прогнать весь бэкенд**

Run: `cd backend && python -m pytest -q`
Expected: PASS, ~397+ тестов

- [ ] **Step 6: Коммит**

```bash
git add backend/app/api/home.py backend/tests/test_catalog_nav.py
git commit -m "feat(home): ось брендов в GET /home по правилам оси категорий"
```

---

### Task 3: `brand` в админке

**Files:**
- Modify: `admin/src/HomeAdmin.tsx:392-395`, `admin/src/HomeAdmin.tsx:449`

- [ ] **Step 1: Добавить тип действия**

Бэкенд принимает `brand` с самого начала (`ACTION_TYPES` в `backend/app/models/home.py`), но в интерфейсе его нет — бренд-плитку сегодня невозможно создать иначе как SQL-запросом. Замени `ACTION_LABELS`:

```tsx
const ACTION_LABELS: Record<string, string> = {
  category: "Категория", brand: "Бренд", search: "Поиск", product: "Товар (id)",
  collection: "Подборка (hot/today/sale)", ai: "AI-запрос", external: "Внешняя ссылка",
};
```

- [ ] **Step 2: Уточнить плейсхолдер значения**

В том же файле, поле «Значение действия»:

```tsx
          <input style={input} placeholder="напр. iphone / смартфоны / Dyson / hot"
```

- [ ] **Step 3: Проверить сборку**

Run: `cd admin && npx tsc --noEmit && npm run build`
Expected: без ошибок

- [ ] **Step 4: Коммит**

```bash
git add admin/src/HomeAdmin.tsx
git commit -m "fix(admin): тип действия «Бренд» в редакторе плиток главной"
```

---

### Task 4: `actionRoute` переезжает в `lib/route.ts`

Чистая функция маршрута нужна и `navTiles`, и `Home`. Пока она живёт внутри `Home.tsx`, её нельзя ни переиспользовать, ни протестировать.

**Files:**
- Modify: `frontend/src/lib/route.ts`, `frontend/src/pages/Home.tsx:38-51`
- Test: `frontend/src/lib/route.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в `frontend/src/lib/route.test.ts`:

```ts
import { actionRoute } from "./route";

describe("actionRoute", () => {
  it("категория ведёт в каталог с фильтром категории", () => {
    expect(actionRoute("category", "смартфоны")).toBe("/catalog?category=%D1%81%D0%BC%D0%B0%D1%80%D1%82%D1%84%D0%BE%D0%BD%D1%8B");
  });

  it("бренд ведёт в каталог с фильтром бренда", () => {
    // Dyson — бренд, а не категория: его товары лежат в «красота» и
    // «бытовая техника», плитка по категории вела в пустоту
    expect(actionRoute("brand", "Dyson")).toBe("/catalog?brand=Dyson");
  });

  it("AI без запроса ведёт в чат, с запросом — с предзаполнением", () => {
    expect(actionRoute("ai", "")).toBe("/ai");
    expect(actionRoute("ai", "макбук")).toBe("/ai?q=%D0%BC%D0%B0%D0%BA%D0%B1%D1%83%D0%BA");
  });

  it("неизвестный тип не роняет навигацию", () => {
    expect(actionRoute("нечто", "x")).toBe("/catalog");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd frontend && npx vitest run src/lib/route.test.ts`
Expected: FAIL — `actionRoute is not exported`

- [ ] **Step 3: Перенести функцию**

Вырежи `actionRoute` из `frontend/src/pages/Home.tsx` (вместе с комментарием над ней) и вставь в конец `frontend/src/lib/route.ts`, добавив `export`:

```ts
/** Маршрут плитки/баннера главной по типу действия из админки.
 *
 * Значения приходят из админки, поэтому результат проходит через
 * safeInternalRoute: наружу увести переходом нельзя. */
export function actionRoute(type: string, value?: string | null): string {
  const v = (value ?? "").trim();
  switch (type) {
    case "category": return `/catalog?category=${encodeURIComponent(v)}`;
    // brand: «Dyson» — это бренд, а не категория (его товары лежат в «красота»
    // и «бытовая техника»), поэтому плитка по категории вела в пустоту.
    case "brand": return `/catalog?brand=${encodeURIComponent(v)}`;
    case "search": return `/catalog?query=${encodeURIComponent(v)}`;
    case "product": return safeInternalRoute(`/product/${encodeURIComponent(v)}`);
    case "collection": return `/catalog?collection=${encodeURIComponent(v)}`;
    case "ai": return v ? `/ai?q=${encodeURIComponent(v)}` : "/ai";
    default: return "/catalog";
  }
}
```

В `Home.tsx` добавь `actionRoute` в существующий импорт из `../lib/route`.

- [ ] **Step 4: Убедиться, что тесты проходят и типы сходятся**

Run: `cd frontend && npx vitest run src/lib/route.test.ts && npx tsc --noEmit`
Expected: PASS, без ошибок типов

- [ ] **Step 5: Коммит**

```bash
git add frontend/src/lib/route.ts frontend/src/lib/route.test.ts frontend/src/pages/Home.tsx
git commit -m "refactor(frontend): actionRoute переезжает в lib/route и покрывается тестами"
```

---

### Task 5: `searchRoute` — маршрут строки поиска

**Files:**
- Create: `frontend/src/lib/searchMode.ts`
- Test: `frontend/src/lib/searchMode.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создай `frontend/src/lib/searchMode.test.ts`:

```ts
import { searchRoute } from "./searchMode";

describe("searchRoute", () => {
  it("режим каталога ведёт в каталог с запросом", () => {
    expect(searchRoute("catalog", "iphone")).toBe("/catalog?query=iphone");
  });

  it("режим AI ведёт в чат с предзаполненным запросом", () => {
    expect(searchRoute("ai", "iphone")).toBe("/ai?q=iphone");
  });

  it("пустой запрос открывает раздел без параметра", () => {
    expect(searchRoute("catalog", "   ")).toBe("/catalog");
    expect(searchRoute("ai", "")).toBe("/ai");
  });

  it("кириллица и служебные символы экранируются", () => {
    expect(searchRoute("catalog", "фен & стайлер")).toBe(
      "/catalog?query=%D1%84%D0%B5%D0%BD%20%26%20%D1%81%D1%82%D0%B0%D0%B9%D0%BB%D0%B5%D1%80",
    );
  });

  it("пробелы по краям не попадают в маршрут", () => {
    expect(searchRoute("ai", "  фен  ")).toBe("/ai?q=%D1%84%D0%B5%D0%BD");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd frontend && npx vitest run src/lib/searchMode.test.ts`
Expected: FAIL — `Cannot find module './searchMode'`

- [ ] **Step 3: Реализовать**

Создай `frontend/src/lib/searchMode.ts`:

```ts
/** Режим строки поиска: обычный поиск по каталогу или AI-подбор.
 *
 *  Логика маршрута вынесена в чистую функцию не ради красоты: одинаковый
 *  обработчик Enter продублирован в Home, Catalog и DesktopHeader, и четвёртая
 *  копия — уже с двумя режимами — разъехалась бы с остальными. Плюс тестируется
 *  в node без DOM, как searchHistory и categoryCache.
 */
export type SearchMode = "catalog" | "ai";

export function searchRoute(mode: SearchMode, query: string): string {
  const q = query.trim();
  if (mode === "ai") return q ? `/ai?q=${encodeURIComponent(q)}` : "/ai";
  return q ? `/catalog?query=${encodeURIComponent(q)}` : "/catalog";
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd frontend && npx vitest run src/lib/searchMode.test.ts`
Expected: PASS, 5 тестов

- [ ] **Step 5: Коммит**

```bash
git add frontend/src/lib/searchMode.ts frontend/src/lib/searchMode.test.ts
git commit -m "feat(frontend): searchRoute — маршрут строки поиска по режиму"
```

---

### Task 6: `navTiles` — чипы навигации по осям

**Files:**
- Create: `frontend/src/lib/navTiles.ts`
- Test: `frontend/src/lib/navTiles.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создай `frontend/src/lib/navTiles.test.ts`:

```ts
import { navTiles } from "./navTiles";

const homeCat = { id: 1, title: "Смартфоны", emoji: "📱", action_type: "category", action_value: "смартфоны" };
const homeBrand = { id: -1001, title: "Dyson", emoji: "🌀", action_type: "brand", action_value: "Dyson" };
const cached = [{ key: "ноутбуки", label: "Ноутбуки", icon: "💻", count: 50 }];

describe("navTiles", () => {
  it("ось категорий берёт плитки из ответа /home", () => {
    const tiles = navTiles("category", { categories: [homeCat], brands: [homeBrand] }, []);
    expect(tiles).toEqual([
      { key: "1", label: "Смартфоны", icon: "📱", route: "/catalog?category=%D1%81%D0%BC%D0%B0%D1%80%D1%82%D1%84%D0%BE%D0%BD%D1%8B" },
    ]);
  });

  it("ось брендов берёт плитки бренда и ведёт в фильтр по бренду", () => {
    const tiles = navTiles("brand", { categories: [homeCat], brands: [homeBrand] }, []);
    expect(tiles).toEqual([
      { key: "-1001", label: "Dyson", icon: "🌀", route: "/catalog?brand=Dyson" },
    ]);
  });

  it("ось брендов пуста, если брендов нет — по этому компонент прячет тумблер", () => {
    expect(navTiles("brand", { categories: [homeCat], brands: [] }, cached)).toEqual([]);
  });

  it("бэкенд без ключа brands не роняет ось брендов", () => {
    expect(navTiles("brand", { categories: [homeCat] }, cached)).toEqual([]);
  });

  it("до ответа /home ось категорий рисуется из кэша", () => {
    const tiles = navTiles("category", null, cached);
    expect(tiles).toEqual([
      { key: "ноутбуки", label: "Ноутбуки", icon: "💻", route: "/catalog?category=%D0%BD%D0%BE%D1%83%D1%82%D0%B1%D1%83%D0%BA%D0%B8" },
    ]);
  });

  it("кэш не подменяет ось брендов: у брендов кэша нет", () => {
    expect(navTiles("brand", null, cached)).toEqual([]);
  });

  it("плитка без эмодзи получает нейтральную иконку", () => {
    const tiles = navTiles("category", { categories: [{ ...homeCat, emoji: null }], brands: [] }, []);
    expect(tiles[0].icon).toBe("🛍️");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd frontend && npx vitest run src/lib/navTiles.test.ts`
Expected: FAIL — `Cannot find module './navTiles'`

- [ ] **Step 3: Реализовать**

Создай `frontend/src/lib/navTiles.ts`:

```ts
import { NavCategory } from "./categoryCache";
import { actionRoute } from "./route";

/** Ось навигации на главной: разделы каталога или бренды. */
export type NavAxis = "category" | "brand";

/** Плитка главной в том виде, в каком её отдаёт GET /home. */
export type HomeTile = {
  id: number;
  title: string;
  emoji?: string | null;
  action_type: string;
  action_value?: string | null;
};

export type HomeAxes = { categories: HomeTile[]; brands?: HomeTile[] };

export type NavChip = { key: string; label: string; icon: string; route: string };

const FALLBACK_ICON = "🛍️";

function fromTiles(tiles: HomeTile[]): NavChip[] {
  return tiles.map((t) => ({
    key: String(t.id),
    label: t.title,
    icon: t.emoji || FALLBACK_ICON,
    route: actionRoute(t.action_type, t.action_value),
  }));
}

/** Чипы навигации для выбранной оси.
 *
 *  Кэш категорий (localStorage) подставляется ТОЛЬКО на оси категорий и только
 *  пока /home не ответил — он нужен, чтобы hero не прыгал при загрузке. У
 *  брендов кэша нет намеренно: ось брендов доступна лишь после ответа /home, а
 *  до него тумблер не показывается, так что подставлять нечего и незачем.
 *
 *  `brands` может отсутствовать: фронт новее бэкенда — обычное состояние во
 *  время выката, и ронять из-за этого навигацию нельзя.
 */
export function navTiles(
  axis: NavAxis,
  home: HomeAxes | null,
  cachedCategories: NavCategory[],
): NavChip[] {
  if (axis === "brand") return fromTiles(home?.brands ?? []);
  const managed = home?.categories ?? [];
  if (managed.length > 0) return fromTiles(managed);
  return cachedCategories.map((c) => ({
    key: c.key, label: c.label, icon: c.icon,
    route: actionRoute("category", c.key),
  }));
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd frontend && npx vitest run src/lib/navTiles.test.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add frontend/src/lib/navTiles.ts frontend/src/lib/navTiles.test.ts
git commit -m "feat(frontend): navTiles — чипы навигации по осям категорий и брендов"
```

---

### Task 7: компонент `SegmentedToggle`

**Files:**
- Create: `frontend/src/components/SegmentedToggle.tsx`

Компонентных тестов нет по устройству проекта (vitest без DOM) — вся решающая логика уже в `navTiles` и `searchRoute`. Проверка компонента — визуальная, в Task 10.

- [ ] **Step 1: Написать компонент**

Создай `frontend/src/components/SegmentedToggle.tsx`:

```tsx
/** Переключатель на два положения. Один компонент на оба тумблера главной:
 *  «Категории / Бренды» над чипами и «Каталог / AI» в строке поиска.
 *
 *  Фиксированная высота — обязательна: тумблер стоит над рядом чипов и над
 *  строкой поиска, и «прыжок» вёрстки при переключении заметен сразу.
 *
 *  variant: на тёмном hero и на светлой поверхности нужен разный контраст,
 *  а это единственное, чем два использования отличаются.
 */
export type SegmentedOption<T extends string> = { value: T; label: string };

export function SegmentedToggle<T extends string>({
  value, onChange, options, ariaLabel, variant = "on-surface",
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  ariaLabel: string;
  variant?: "on-dark" | "on-surface";
}) {
  const track = variant === "on-dark"
    ? "bg-white/[0.13] ring-1 ring-inset ring-white/15"
    : "bg-mutedbg";
  const active = variant === "on-dark"
    ? "bg-white text-text shadow-soft"
    : "bg-surface text-text shadow-soft";
  const idle = variant === "on-dark" ? "text-white/80" : "text-muted";

  /** Стрелки переключают вкладки — ожидаемое поведение tablist с клавиатуры. */
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = e.key === "ArrowRight" ? i + 1 : i - 1;
    const target = options[(next + options.length) % options.length];
    if (target) onChange(target.value);
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`inline-flex h-9 shrink-0 items-center gap-0.5 rounded-full p-0.5 ${track}`}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`tap h-8 whitespace-nowrap rounded-full px-3.5 text-[13px] font-semibold transition-colors ${selected ? active : idle}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add frontend/src/components/SegmentedToggle.tsx
git commit -m "feat(frontend): SegmentedToggle — переключатель на два положения"
```

---

### Task 8: тумблер «Категории / Бренды» на главной

**Files:**
- Modify: `frontend/src/pages/Home.tsx` — тип `HomeData`, состояние, hero-чипы, `HomeSidebar`

- [ ] **Step 1: Расширить тип ответа и завести состояние оси**

В `frontend/src/pages/Home.tsx` замени тип `HomeData`:

```tsx
type HomeData = { banners: HomeBanner[]; categories: HomeCat[]; brands?: HomeCat[] };
```

Добавь импорты:

```tsx
import { SegmentedToggle } from "../components/SegmentedToggle";
import { navTiles, NavAxis } from "../lib/navTiles";
```

Рядом с остальным состоянием компонента (после `const [home, setHome] = ...`):

```tsx
  // Ось навигации общая для hero-чипов и desktop-сайдбара: если развести их по
  // разным состояниям, hero покажет бренды, а сайдбар рядом — категории.
  // Не сохраняется между визитами намеренно: по умолчанию всегда «Категории».
  const [axis, setAxis] = useState<NavAxis>("category");
```

- [ ] **Step 2: Перевести hero-чипы на `navTiles`**

Замени блок `const heroChips = ...` (вычисление приоритета «админские категории → каталог → фолбэк») на:

```tsx
  // Чипы навигации: источник и приоритет теперь в navTiles (чистая функция,
  // покрыта тестами). Считаем один раз — hero режет ряд до 6, сайдбар берёт всё.
  const navChips = navTiles(axis, home, categories);
  const heroChips = navChips.slice(0, 6);
  // Ось брендов существует только когда бренды реально пришли: переключатель во
  // вкладку без содержимого — та же мёртвая плитка, только в виде тумблера.
  const hasBrandAxis = (home?.brands ?? []).length > 0;
```

- [ ] **Step 3: Поставить тумблер над рядом чипов**

Найди ряд чипов (`<div className="no-scrollbar -mx-4 mt-4 flex gap-2 overflow-x-auto px-4">`) и вставь перед ним:

```tsx
        {hasBrandAxis && (
          <div className="mt-4 flex items-center">
            <SegmentedToggle
              value={axis}
              onChange={(next) => { setAxis(next); track("home_axis_switched", { axis: next }); }}
              options={[
                { value: "category", label: "Категории" },
                { value: "brand", label: "Бренды" },
              ] as const}
              ariaLabel="Навигация по каталогу"
              variant="on-dark"
            />
          </div>
        )}
```

И у самого ряда чипов замени `mt-4` на `mt-3`, чтобы отступ между тумблером и чипами не удваивался:

```tsx
        <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4">
```

- [ ] **Step 4: Подписать хвостовую кнопку по оси**

В том же ряду замени кнопку «Все категории →»:

```tsx
          <button
            onClick={() => navigate("/catalog")}
            className="tap shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-semibold text-white/90 ring-1 ring-inset ring-white/25 transition-colors hover:bg-white/10"
          >
            {axis === "brand" ? "Все бренды →" : "Все категории →"}
          </button>
```

- [ ] **Step 5: Прокинуть ось в desktop-сайдбар**

В месте вызова `<HomeSidebar .../>` замени пропсы `categories`/`homeCats` на готовые чипы и ось:

```tsx
        <HomeSidebar
          tiles={navChips}
          axis={axis}
          onAxis={hasBrandAxis ? (next: NavAxis) => { setAxis(next); track("home_axis_switched", { axis: next }); } : null}
          onCategory={(route) => navigate(safeInternalRoute(route))}
          onScenario={openScenario}
          onManager={() => { if (!openExternalLink(config.manager_retail_url)) navigate("/ai"); }}
        />
```

- [ ] **Step 6: Переписать шапку сайдбара**

В компоненте `HomeSidebar` замени сигнатуру и вычисление `cats`:

```tsx
function HomeSidebar({
  tiles, axis, onAxis, onCategory, onScenario, onManager,
}: {
  tiles: NavChip[];
  axis: NavAxis;
  onAxis: ((next: NavAxis) => void) | null;
  onCategory: (route: string) => void;
  onScenario: (k: ScenarioKey) => void;
  onManager: () => void;
}) {
```

Добавь импорт типа: `import { navTiles, NavAxis, NavChip } from "../lib/navTiles";`

Внутри удали блок `const cats = homeCats.length > 0 ? ... : ...` целиком, а в разметке замени заголовок и список:

```tsx
      <div className="rounded-xl2 bg-surface p-2 shadow-soft">
        {onAxis ? (
          <div className="px-2 pb-1 pt-2">
            <SegmentedToggle
              value={axis}
              onChange={onAxis}
              options={[
                { value: "category", label: "Категории" },
                { value: "brand", label: "Бренды" },
              ] as const}
              ariaLabel="Навигация по каталогу"
            />
          </div>
        ) : (
          <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Категории</p>
        )}
        {(tiles.length ? tiles : [{ key: "_", label: "Каталог", icon: "🛍️", route: "/catalog" }]).map((c) => (
```

Остальная разметка списка не меняется.

- [ ] **Step 7: Проверить типы и сборку**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: без ошибок, все тесты зелёные

- [ ] **Step 8: Коммит**

```bash
git add frontend/src/pages/Home.tsx
git commit -m "feat(home): тумблер «Категории / Бренды» над навигацией главной"
```

---

### Task 9: тумблер «Каталог / AI» в строке поиска

**Files:**
- Modify: `frontend/src/pages/Home.tsx` — строка поиска hero
- Modify: `frontend/src/components/DesktopHeader.tsx` — строка поиска шапки

- [ ] **Step 1: Режим поиска на главной**

В `Home.tsx` добавь импорт `import { SearchMode, searchRoute } from "../lib/searchMode";` и состояние рядом с `const [searchOpen, ...]`:

```tsx
  // Режим строки поиска. Не сохраняется между визитами: по умолчанию всегда
  // каталог, AI — осознанное переключение.
  const [searchMode, setSearchMode] = useState<SearchMode>("catalog");
```

Замени `goSearch`:

```tsx
  function goSearch() {
    const q = search.trim();
    if (q) {
      pushSearchQuery(q);
      track("search_query_submitted", {
        query_length: q.length, source: "home_enter", mode: searchMode,
      });
    }
    navigate(searchRoute(searchMode, search));
  }
```

- [ ] **Step 2: Заменить кнопку «✨ AI» тумблером**

Отдельная кнопка «✨ AI» рядом с поиском уводила в чат без запроса — тумблер делает то же самое и вдобавок переносит уже введённый текст, поэтому кнопка убирается, а не дублируется. Замени блок `<button onClick={() => navigate("/ai")} aria-label="AI-подбор" ...>✨ AI</button>` на:

```tsx
          <SegmentedToggle
            value={searchMode}
            onChange={(next) => { setSearchMode(next); track("search_mode_switched", { mode: next, source: "home" }); }}
            options={[
              { value: "catalog", label: "Каталог" },
              { value: "ai", label: "✨ AI" },
            ] as const}
            ariaLabel="Режим поиска"
            variant="on-dark"
          />
```

- [ ] **Step 3: Плейсхолдер по режиму**

У инпута главной замени `placeholder`:

```tsx
              placeholder={searchMode === "ai" ? "Опишите, что нужно — подберём" : "Найти iPhone, MacBook, AirPods…"}
              aria-label={searchMode === "ai" ? "AI-подбор" : "Поиск по каталогу"}
```

- [ ] **Step 4: Режим поиска в desktop-шапке**

В `DesktopHeader.tsx` добавь импорты:

```tsx
import { SegmentedToggle } from "./SegmentedToggle";
import { SearchMode, searchRoute } from "../lib/searchMode";
```

Заведи состояние рядом с существующим `panelOpen`:

```tsx
  const [mode, setMode] = useState<SearchMode>("catalog");
```

Замени обработчик Enter:

```tsx
              onKeyDown={(e) => {
                if (e.key === "Escape") { setPanelOpen(false); e.currentTarget.blur(); }
                if (e.key === "Enter") {
                  const trimmed = q.trim();
                  if (trimmed.length >= 2) {
                    pushSearchQuery(trimmed);
                    track("search_query_submitted", {
                      query_length: trimmed.length, source: "desktop_enter", mode,
                    });
                    navigate(searchRoute(mode, trimmed));
                  }
                  setPanelOpen(false);
                }
              }}
```

И плейсхолдер:

```tsx
              placeholder={mode === "ai" ? "Опишите, что нужно — подберём" : "Найти iPhone, MacBook, PlayStation…"}
              aria-label={mode === "ai" ? "AI-подбор" : "Поиск по каталогу"}
```

- [ ] **Step 5: Поставить тумблер в шапке**

Внутри `<div className="flex min-w-0 items-center gap-2 rounded-xl2 bg-mutedbg px-4 ...">`, сразу после кнопки очистки `{q && (...)}`, добавь:

```tsx
            <SegmentedToggle
              value={mode}
              onChange={(next) => { setMode(next); track("search_mode_switched", { mode: next, source: "desktop_header" }); }}
              options={[
                { value: "catalog", label: "Каталог" },
                { value: "ai", label: "✨ AI" },
              ] as const}
              ariaLabel="Режим поиска"
            />
```

- [ ] **Step 6: Проверить типы, тесты и сборку**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: без ошибок, все тесты зелёные

- [ ] **Step 7: Коммит**

```bash
git add frontend/src/pages/Home.tsx frontend/src/components/DesktopHeader.tsx
git commit -m "feat(search): тумблер «Каталог / AI» в строке поиска главной и шапки"
```

---

### Task 10: живая проверка в браузере

**Files:** нет — только проверка

- [ ] **Step 1: Поднять демо-стек**

```bash
docker compose -f docker-compose.demo.yml up -d
```

- [ ] **Step 2: Перезапустить фронт**

Vite не видит правки через bind-mount на Windows — без этого в браузере останется старый модуль:

```bash
docker compose -f docker-compose.demo.yml restart frontend
```

- [ ] **Step 3: Проверить ось навигации**

Открой `http://localhost:5173`. Убедись:
- тумблер «Категории / Бренды» виден над рядом чипов;
- в положении «Бренды» чипы — Apple, Dyson, Sony, клик по Dyson открывает `/catalog?brand=Dyson` с непустой выдачей;
- на desktop (ширина ≥1024) список в сайдбаре переключается вместе с hero, а не отдельно;
- при переключении ряд чипов не «прыгает» по высоте.

- [ ] **Step 4: Проверить режим поиска**

- в режиме «Каталог» Enter уводит в `/catalog?query=…`;
- переключение в «✨ AI» сохраняет введённый текст;
- Enter в режиме AI открывает `/ai?q=…` с уже подставленным запросом;
- плейсхолдер меняется вместе с режимом.

- [ ] **Step 5: Проверить пустую ось брендов**

В админке (`http://localhost:5174`) сними `is_active` со всех товаров одного бренда или проверь на пустом каталоге, что при отсутствии брендов тумблер **не рендерится вовсе**, а не показывает пустую вкладку.

- [ ] **Step 6: Консоль без ошибок**

Проверь консоль браузера: ошибок и предупреждений React быть не должно.

---

### Task 11: полная проверка и деплой

**Files:** нет — только проверка и выкат

- [ ] **Step 1: Полный прогон**

```bash
cd backend && python -m pytest -q
```
Expected: PASS

```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: PASS

```bash
cd admin && npx tsc --noEmit && npm run build
```
Expected: PASS

- [ ] **Step 2: Проверить чистоту дерева**

Деплой синхронизирует ВСЁ рабочее дерево — незакоммиченные правки уедут в прод.

```bash
git status --porcelain
```
Expected: пусто

- [ ] **Step 3: Деплой**

Только из Git Bash — обычный `bash` в PATH уходит в WSL, где нет SSH-алиаса `iseller`:

```bash
bash update-server.sh
```

- [ ] **Step 4: Показать прод-SQL пользователю и дождаться подтверждения**

Не выполнять без явного «да». Плитка Dyson заведена как категория `dyson`, которой в каталоге нет; «Аксессуары» — то же самое:

```sql
UPDATE home_categories SET action_type='brand', action_value='Dyson' WHERE action_value='dyson';
DELETE FROM home_categories WHERE action_type='category' AND action_value='аксессуары';
```

`UPDATE`, а не `DELETE` для Dyson: строка хранит эмодзи, градиент и позицию 6 — оформление, которое иначе пришлось бы заводить заново. Без этого SQL Dyson всё равно появится на оси брендов автоматически, но с дефолтным оформлением и в конце ряда.

- [ ] **Step 5: Проверить прод после выката**

```bash
curl -s -m 20 https://158.255.1.248.sslip.io/api/health
```
Expected: `{"status":"ok","database":"ok"}`

Открой Mini App и убедись, что тумблер на месте, а Dyson открывается с товарами.

---

## Что осталось за рамками плана

- Тумблер поиска внутри `/catalog` (там пользователь уже в каталоге).
- Сохранение выбранной оси и режима поиска между визитами.
- Логотипы брендов вместо эмодзи.
- Открытые хвосты проекта: `Enter` в AI-чате, фильтры по региону/памяти/размеру, свободный текст в боте, латентность LLM, гейтвей для Anthropic в открытом регионе.
