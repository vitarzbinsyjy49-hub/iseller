# Шапка со знаком и навигация по образцу Telegram — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поставить знак бренда в полосу плавающих кнопок Telegram, превратить нижнюю навигацию в пилюлю из 4 вкладок с отдельным кругом поиска и перенести заявки в профиль с бейджем непросмотренных изменений.

**Architecture:** Всё, что нужно, в проекте уже есть — fullscreen включён, safe-area разложена по CSS-переменным, решение «стекло или сплошное» вынесено в `navGlass.ts`, геометрия низа сведена к одной переменной `--bottom-nav-height`, а `updated_at` заявки уже приходит с сервера. Работа состоит в том, чтобы занять уже нарисованную пустую полосу, изменить форму уже существующей панели и посчитать бейдж из уже приходящих данных. Backend не трогается вообще.

**Tech Stack:** React 18 + TypeScript + Vite, Tailwind, zustand, react-router-dom, vitest (node-окружение, без DOM).

Спека: `docs/superpowers/specs/2026-09-05-telegram-nav-and-header-design.md`.

## Global Constraints

Действуют во всех задачах без исключения:

- **safe-area компенсируется ровно один раз.** Никогда не суммировать `env(safe-area-inset-*)` со значениями Telegram и не применять `.safe-bottom` дважды по цепочке.
- **Движение, которое человек должен увидеть, идёт через `lib/motion.ts` (rAF).** Никаких `transition`/`animation` для этого: Telegram WebView гасит декларативную анимацию целиком. `transition-colors` на смене цвета допустим — он уже есть в `BottomNav` и к движению не относится.
- **`frontend/src/lib/navGlass.ts` не меняется.** Форма панели одна на всех экранах, различается только материал, а `"glass" | "solid"` — ровно то, что модуль уже возвращает. Если правка вынуждает его тронуть — остановиться и вернуться к спеке.
- **Маршруты поиска только через `frontend/src/lib/searchRoutes.ts`.** Строка всегда ищет по каталогу, кнопка «✨ ИИ» всегда открывает `/ai`. Четвёртой копии обработчика не заводить.
- **Маршрут `/requests` остаётся живым.** На него ведут диплинки из бота и уведомления о смене статуса. Меняется только вход в него.
- **`pointer-events: none` у `.hero-top-inset` сохраняется.** Иначе знак перехватит нажатие по кнопке «Закрыть» Telegram.
- **Backend не трогаем.** Ни моделей, ни схем, ни миграций, ни `REQUIRED_SCHEMA` бота.
- **Никакого `liquid-glass-js`, WebGL и `html2canvas`.**

## Карта файлов

| файл | что с ним |
|---|---|
| `frontend/src/lib/viewport.ts` | +`brandMarkVisible()`; правка `bottomNavStack()` под новый зазор |
| `frontend/src/lib/viewport.test.ts` | тесты обоих |
| `frontend/src/components/Layout.tsx` | знак внутрь `.hero-top-inset` |
| `frontend/src/index.css` | `.hero-top-inset` (два пояса), `.nav-surface` (пилюля), `--bottom-nav-height` (+зазор) |
| `frontend/src/pages/Home.tsx` | логотип из липкой шапки → мелкий заголовок |
| `frontend/src/lib/useCollapsingHeader.ts` | запись обратного прогресса для мелкого заголовка |
| `frontend/src/components/BottomNav.tsx` | 4 вкладки, круг поиска, бейдж на «Профиле» |
| `frontend/src/pages/Catalog.tsx` | фокус на строке поиска по `?focus=search` |
| `frontend/src/lib/leads.ts` | +`unseenLeadCount()` |
| `frontend/src/lib/leads.test.ts` | тесты счёта |
| `frontend/src/store/leadsBadge.ts` | **создать** — стор счётчика |
| `frontend/src/pages/Profile.tsx` | заявки выделенной кнопкой под шапкой, бейдж из стора |
| `frontend/src/pages/Requests.tsx` | штамп `lastSeen` при открытии |

---

### Task 1: Знак бренда в полосе Telegram

**Files:**
- Modify: `frontend/src/lib/viewport.ts`
- Modify: `frontend/src/lib/viewport.test.ts`
- Modify: `frontend/src/components/Layout.tsx:124`
- Modify: `frontend/src/index.css:115-124`
- Test: `frontend/src/lib/viewport.test.ts`

**Interfaces:**
- Consumes: `computeSafeArea` (уже есть, не меняется); `BrandWordmark` из `frontend/src/components/BrandMark.tsx` — сигнатура `({ size?: number, className?: string })`.
- Produces: `brandMarkVisible(s: BrandMarkSources): boolean`. Задачами 2–7 не используется.

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `frontend/src/lib/viewport.test.ts`:

```ts
import { brandMarkVisible } from "./viewport";

describe("brandMarkVisible", () => {
  it("вне Telegram знака нет: полосы кнопок не существует", () => {
    expect(brandMarkVisible({ insideTelegram: false, isFullscreen: true, contentSafeTop: 46 })).toBe(false);
  });

  it("в Telegram без fullscreen знака нет: шапка Telegram вне webview", () => {
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: false, contentSafeTop: 46 })).toBe(false);
  });

  it("fullscreen с нулевой полосой не показывает знак: рисовать его негде", () => {
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: true, contentSafeTop: 0 })).toBe(false);
  });

  it("fullscreen с ненулевой полосой показывает знак", () => {
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: true, contentSafeTop: 46 })).toBe(true);
  });

  it("отсутствующая величина полосы читается как ноль, а не как истина", () => {
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: true, contentSafeTop: null })).toBe(false);
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: true, contentSafeTop: NaN })).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd frontend && npx vitest run src/lib/viewport.test.ts
```

Ожидается: FAIL — `brandMarkVisible is not exported`.

- [ ] **Step 3: Написать функцию**

Дописать в `frontend/src/lib/viewport.ts` после `computeSafeArea`:

```ts
export type BrandMarkSources = {
  insideTelegram: boolean;
  /** Telegram.WebApp.isFullscreen. */
  isFullscreen: boolean;
  /** Telegram.WebApp.contentSafeAreaInset.top — высота пояса, в котором
   *  Telegram держит свои плавающие кнопки. */
  contentSafeTop?: number | null;
};

/** Виден ли знак бренда в полосе плавающих кнопок Telegram.
 *
 *  Знак живёт в чужой полосе, и права на неё у нас появляются РОВНО в
 *  fullscreen: только там Telegram убирает свою шапку и оставляет висеть над
 *  страницей две пилюли, между которыми есть свободное место. Вне fullscreen
 *  webview начинается ПОД шапкой Telegram, полоса имеет нулевую высоту, и знак
 *  в ней был бы схлопнутым узлом поверх контента.
 *
 *  Третье условие — ненулевая высота пояса — не перестраховка: клиент может
 *  сообщить fullscreen раньше, чем пришлют contentSafeAreaInset, и знак успел
 *  бы мигнуть в полосе высотой 0.
 */
export function brandMarkVisible(s: BrandMarkSources): boolean {
  if (!s.insideTelegram || !s.isFullscreen) return false;
  const top = s.contentSafeTop;
  return typeof top === "number" && Number.isFinite(top) && top > 0;
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
cd frontend && npx vitest run src/lib/viewport.test.ts
```

Ожидается: PASS.

- [ ] **Step 5: Разделить полосу на два пояса в CSS**

Заменить блок `.hero-top-inset` в `frontend/src/index.css` (строки 115–124) на:

```css
.hero-top-inset {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--app-content-top-offset, env(safe-area-inset-top, 0px));
  background: var(--app-header-color);
  z-index: 30;
  /* Знак некликабелен, а под полосой лежат кнопки Telegram «Закрыть» и «⋯».
     Перехват нажатий здесь означал бы, что из приложения нельзя выйти. */
  pointer-events: none;
  /* Верхний пояс — системный статус-бар (часы, сеть, батарея), туда нельзя
     класть ничего. Знак центрируется в НИЖНЕМ поясе, где Telegram держит свои
     плавающие кнопки. Отсюда padding сверху ровно на высоту статус-бара. */
  padding-top: var(--tg-safe-area-top, 0px);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Знак внутри полосы.
   120px с каждой стороны — место под пилюли Telegram. Расчёт: на 390pt
   свободного остаётся 150pt при потребности знака ~125pt; на минимальных
   375pt — 135pt. Влезает на всех устройствах, где Telegram даёт fullscreen,
   поэтому отдельной ветки для узких экранов нет.
   overflow:hidden — последняя защита: если Telegram однажды расширит свои
   кнопки, знак обрежется, а не наедет на них. */
.hero-top-inset > .brand-slot {
  max-width: calc(100% - 240px);
  overflow: hidden;
  color: #fff;
}
```

- [ ] **Step 6: Вставить знак в Layout**

В `frontend/src/components/Layout.tsx` заменить строку 124 (`<div aria-hidden className="hero-top-inset lg:hidden" />`) на:

```tsx
      {/* Знак бренда в полосе плавающих кнопок Telegram. Виден только в
          fullscreen: вне его полоса имеет нулевую высоту и рисовать негде
          (решение — brandMarkVisible в lib/viewport.ts, покрыто тестами).
          Здесь читаем его дешёвый признак: класс tg-fullscreen на <html>,
          который уже проставляет lib/telegram.ts. */}
      <div aria-hidden className="hero-top-inset lg:hidden">
        <span className="brand-slot">
          <BrandWordmark size={26} />
        </span>
      </div>
```

И добавить импорт в шапку файла:

```tsx
import { BrandWordmark } from "./BrandMark";
```

- [ ] **Step 7: Спрятать знак вне fullscreen**

Дописать в `frontend/src/index.css` сразу после блока `.hero-top-inset > .brand-slot`:

```css
/* Вне fullscreen полоса имеет нулевую высоту, но её содержимое всё равно
   участвовало бы в раскладке flex-контейнера и могло бы вылезти за границы.
   Класс tg-fullscreen ставит lib/telegram.ts. */
html:not(.tg-fullscreen) .hero-top-inset > .brand-slot { display: none; }
```

- [ ] **Step 8: Проверить типы и сборку**

```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```

Ожидается: без ошибок.

- [ ] **Step 9: Коммит**

```bash
git add frontend/src/lib/viewport.ts frontend/src/lib/viewport.test.ts frontend/src/components/Layout.tsx frontend/src/index.css
git commit -m "feat(шапка): знак бренда в полосе плавающих кнопок Telegram"
```

---

### Task 2: Мелкий заголовок в освободившемся слоте главной

Логотип уехал наверх (Task 1), и в липкой шапке главной освободился левый слот. Оставить его пустым нельзя: `HeroActions` уедут вправо, а половина шапки будет зиять. Слот занимает мелкий заголовок, проявляющийся ровно по мере таяния крупного — поведение больших заголовков iOS, ради которого `useCollapsingHeader` и писался.

**Files:**
- Modify: `frontend/src/lib/useCollapsingHeader.ts`
- Modify: `frontend/src/pages/Home.tsx:358-372`

**Interfaces:**
- Consumes: `collapseProgress(scrollTop, distance)` — уже экспортирована из `useCollapsingHeader.ts`, возвращает 0..1.
- Produces: узел с атрибутом `data-collapsing-smalltitle`, которому мотор покадрово пишет `style.opacity`. Другими задачами не используется.

- [ ] **Step 1: Найти третий узел вместе с двумя существующими**

В `frontend/src/lib/useCollapsingHeader.ts` в теле ref-колбэка, сразу после строк

```ts
    const nav = el.querySelector<HTMLElement>("[data-collapsing-nav]");
    const title = el.querySelector<HTMLElement>("[data-collapsing-title]");
    if (!nav && !title) return;
```

добавить третью выборку — строкой ниже `title`, ДО проверки `if (!nav && !title)`:

```ts
    // Мелкий заголовок в слоте, освободившемся от логотипа. Ищется здесь же и
    // тем же способом: у вызывающей стороны остаётся один ref, а участие узла
    // в схлопывании по-прежнему видно по атрибуту прямо в JSX.
    const small = el.querySelector<HTMLElement>("[data-collapsing-smalltitle]");
```

Условие раннего выхода не трогать: мелкий заголовок без крупного и без шапки смысла не имеет.

- [ ] **Step 2: Писать ему обратный прогресс**

В той же функции, в теле `apply()`, сразу после блока `if (title) { … }` добавить:

```ts
      // Появляется во ВТОРОЙ половине таяния крупного. Если вести мелкий тем же
      // обратным прогрессом от нуля, обе фразы половину пути видны
      // одновременно и читаются как дублирование, а не как передача эстафеты.
      // Только opacity: движение здесь уже есть у крупного заголовка, второе
      // на тех же 72 пикселях превратило бы передачу в суету.
      if (small) small.style.opacity = Math.max(0, (p - 0.5) * 2).toFixed(3);
```

`p` — прогресс 0..1, уже посчитанный в `apply()` строкой выше.

- [ ] **Step 3: Заменить логотип в шапке главной на мелкий заголовок**

В `frontend/src/pages/Home.tsx` заменить блок строк 360–366 (комментарий про логотип и `<div className="min-w-0"><BrandWordmark size={30} /></div>`) на:

```tsx
          {/* Знак бренда уехал в полосу плавающих кнопок Telegram (Layout,
              .hero-top-inset). Освободившийся слот занимает мелкий заголовок:
              он проявляется ровно по мере таяния крупного (data-collapsing-title
              ниже), и шапка не остаётся с дырой на месте логотипа.
              opacity: 0 в разметке — стартовое состояние; дальше значение
              покадрово пишет lib/useCollapsingHeader.ts. */}
          <div className="min-w-0">
            <span
              data-collapsing-smalltitle
              style={{ opacity: 0 }}
              className="block truncate text-[15px] font-semibold tracking-tight"
            >
              Техника, которую легко найти
            </span>
          </div>
```

- [ ] **Step 4: Убрать осиротевший импорт**

Если `BrandWordmark` больше нигде в `Home.tsx` не используется, удалить его импорт (строка 26). Проверить:

```bash
cd frontend && grep -n "BrandWordmark" src/pages/Home.tsx
```

- [ ] **Step 5: Проверить типы, тесты и сборку**

```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```

Ожидается: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add frontend/src/lib/useCollapsingHeader.ts frontend/src/pages/Home.tsx
git commit -m "feat(главная): мелкий заголовок в слоте, освободившемся от логотипа"
```

---

### Task 3: Геометрия низа под плавающую пилюлю

Пилюля отрывается от нижней кромки, и на величину зазора должно вырасти `--bottom-nav-height`. От неё уже зависят `.cta-dock`, `.cart-dock` и `.pb-cta` — все едут следом сами; `.pb-nav` и `.toast-dock` в ходе этой работы были переведены на ту же переменную. Одновременно правится `bottomNavStack()` в `viewport.ts`: эта функция — зеркало той же геометрии, живущее только ради тестов, и рассинхрон с CSS сделает её ложью.

**Files:**
- Modify: `frontend/src/index.css:458-468`
- Modify: `frontend/src/lib/viewport.ts:149-170`
- Modify: `frontend/src/lib/viewport.test.ts:142-156`

**Interfaces:**
- Consumes: ничего из предыдущих задач.
- Produces: CSS-переменная `--nav-float-gap` (используется Task 4); `bottomNavStack(safeBottom)` сохраняет прежнюю сигнатуру и прежние имена полей — `{ navHeight, ctaBottomOffset, clearance, contentPadBottom }`.

- [ ] **Step 1: Обновить тесты геометрии**

В `frontend/src/lib/viewport.test.ts` заменить существующие ожидания `bottomNavStack` (строки 142–156) на:

```ts
  it("плавающая пилюля добавляет зазор ОДИН раз, поверх safe-area", () => {
    // 64 контент + max(8, safe) + 10 зазора
    expect(bottomNavStack(0).navHeight).toBe(64 + 8 + 10);
    expect(bottomNavStack(-5).navHeight).toBe(64 + 8 + 10);
    expect(bottomNavStack(NaN).navHeight).toBe(64 + 8 + 10);
  });

  it("на устройстве с вырезом safe-area прибавляется вместо минимума, а не к нему", () => {
    const s = bottomNavStack(34);
    expect(s.navHeight).toBe(64 + 34 + 10); // 108, а не 64+8+34+10
  });

  it("разница между вырезом и плоским низом равна разнице safe-area", () => {
    const notched = bottomNavStack(34);
    const flat = bottomNavStack(8);
    expect(notched.navHeight - flat.navHeight).toBe(26);
  });

  it("кнопка дока по-прежнему стоит выше навигации", () => {
    const s = bottomNavStack(34);
    expect(s.ctaBottomOffset).toBeGreaterThan(s.navHeight);
    expect(s.clearance).toBe(16);
  });
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cd frontend && npx vitest run src/lib/viewport.test.ts
```

Ожидается: FAIL — `expected 72 to be 82` (и аналогичные).

- [ ] **Step 3: Учесть зазор в функции-зеркале**

В `frontend/src/lib/viewport.ts` в теле `bottomNavStack` добавить константу и включить её в высоту:

```ts
  const NAV_CONTENT = 64; // --bottom-nav-content
  // Зазор под плавающей пилюлей. Ровно то же число, что --nav-float-gap в
  // index.css: эта функция — зеркало CSS-геометрии, и расхождение здесь не
  // «неточность», а тест, который врёт про прод.
  const FLOAT_GAP = 10;
  const CLEARANCE = 16; // подъём кнопки над навбаром
  const CTA_AIR = 80; // .pb-cta = ctaBottomOffset + 80 (бар над кнопкой ~64px + воздух)
  const safe = Number.isFinite(safeBottom) && safeBottom > 0 ? safeBottom : 0;
  const effSafe = Math.max(8, safe); // max(0.5rem, safe) — один раз
  const navHeight = NAV_CONTENT + effSafe + FLOAT_GAP;
  const ctaBottomOffset = navHeight + CLEARANCE;
```

Остальное тело функции (`return`) не трогать: `clearance` считается как `ctaBottomOffset - navHeight` и остаётся равным 16.

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd frontend && npx vitest run src/lib/viewport.test.ts
```

Ожидается: PASS.

- [ ] **Step 5: Учесть зазор в CSS**

В `frontend/src/index.css` заменить блок `:root` (строки 458–464) на:

```css
:root {
  --bottom-nav-content: 64px;
  /* Зазор между пилюлей навигации и нижней кромкой экрана. Та же величина
     продублирована константой FLOAT_GAP в lib/viewport.ts — там она нужна
     тестам геометрии; менять эти два числа только вместе. */
  --nav-float-gap: 10px;
  /* safe-area входит РОВНО ОДИН раз (тот же max(0.5rem,…), что и .safe-bottom
     на самой навигации), зазор прибавляется поверх неё. */
  --bottom-nav-height: calc(
    var(--bottom-nav-content)
    + max(0.5rem, var(--app-safe-bottom, env(safe-area-inset-bottom, 0px)))
    + var(--nav-float-gap)
  );
  /* Высота панели корзины вместе с зазором. Один источник и для позиции самой
     панели, и для нижнего отступа контента под ней. */
  --cart-bar-space: 80px;
}
```

- [ ] **Step 6: Проверить типы, тесты и сборку**

```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```

Ожидается: без ошибок.

- [ ] **Step 7: Коммит**

```bash
git add frontend/src/index.css frontend/src/lib/viewport.ts frontend/src/lib/viewport.test.ts
git commit -m "refactor(навигация): зазор под плавающую пилюлю в геометрии низа"
```

---

### Task 4: Ряд из пилюли и круга поиска

Форма и состав меняются **одной** задачей намеренно. Разделить их значило бы на первом шаге повесить позиционирование на `<nav>`, а на втором снять его оттуда и перевесить на потомка: полтора экрана CSS, написанных, чтобы тут же быть переписанными.

**Files:**
- Modify: `frontend/src/index.css` (блок `.nav-surface`, строки ~319–322 и `@supports`-блок ниже)
- Modify: `frontend/src/components/BottomNav.tsx` — список вкладок (строки ~26–70) и разметка (~180–220)
- Modify: `frontend/src/pages/Catalog.tsx` (фокус строки поиска)

**Interfaces:**
- Consumes: `--nav-float-gap` из Task 3; `catalogSearchRoute` из `frontend/src/lib/searchRoutes.ts` — сигнатура `(query: string) => string`.
- Produces: структура `.nav-row > (.nav-surface.nav-pill + .nav-surface.nav-circle)`; маршрут `/catalog?focus=search`. Task 6 добавляет точку на вкладку «Профиль», опираясь на то, что она осталась в списке `items`.

**Важно про `data-glass`:** `useGlassFill` ставит атрибут на узел из `ref`, то есть на `<nav>` — теперь это `.nav-row`. Стеклянные правила поэтому переезжают на потомковые селекторы. Сам `useGlassFill` и `navGlass.ts` не меняются.

- [ ] **Step 1: Оторвать ряд от кромки**

В `frontend/src/index.css` заменить блок `.nav-surface` на:

```css
/* Панель оторвана от нижней кромки и стала пилюлей — раскладка Telegram iOS 26.
   Это не только вид: размывать надо примерно на треть меньше пикселей, чем у
   панели во всю ширину, а нижняя навигация — единственный элемент, который
   переживает КАЖДУЮ прокрутку приложения.

   Боковые поля намеренно узкие (8px, не 16–20). У Telegram пилюля идёт почти
   во всю ширину; с широкими полями четыре вкладки становятся теснее нынешних
   пяти без всякой на то нужды. */
.nav-surface {
  background: rgb(var(--app-surface) / .97);
  box-shadow: 0 -8px 24px rgba(17, 24, 39, .035);
}
/* Ряд сам по себе невидим — он только держит позицию пилюли и круга. */
.nav-row {
  left: 8px;
  right: 8px;
  bottom: max(var(--nav-float-gap), var(--app-safe-bottom, env(safe-area-inset-bottom, 0px)));
}
/* Форма у обоих одна: рамка теперь по кругу, а не только сверху — у
   оторванной панели «верхней кромки» в прежнем смысле нет. */
.nav-pill, .nav-circle {
  border-radius: 999px;
  border: 1px solid rgb(var(--app-border));
  /* Скругление обязано резать и подложку размытия, иначе в углах остаётся
     волосяной шов прямоугольного слоя. */
  overflow: hidden;
  box-shadow: 0 6px 24px rgba(17, 24, 39, .10);
}
```

- [ ] **Step 2: Сделать капсулу видимой над непрозрачным доком**

Дописать сразу следом:

```css
/* Над непрозрачной панелью страницы (.cta-dock) стекла нет — размывать там
   нечего, это решение navGlass.ts. Но заливка .97 поверх подложки того же
   цвета делает пилюлю невидимой: она сливается с доком в один прямоугольник.
   Поэтому в сплошном состоянии капсулу держат обводка и тень, а не фон. */
.nav-row[data-glass="off"] .nav-pill,
.nav-row[data-glass="off"] .nav-circle {
  border-color: rgb(var(--app-border));
  box-shadow: 0 4px 16px rgba(17, 24, 39, .14);
}
```

- [ ] **Step 3: Переселить стеклянные правила на потомков**

`useGlassFill` ставит `data-glass` на узел из `ref`, то есть на `<nav>` — теперь это `.nav-row`, а `.nav-surface` висит на пилюле и круге внутри. Селекторы стекла поэтому становятся потомковыми.

В `@supports`-блоке заменить открывающий селектор:

```css
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .nav-row[data-glass="on"] .nav-surface {
```

Значения внутри (`--nav-glass-t`, `background`, `backdrop-filter`) оставить как есть, а `box-shadow` и правило границы заменить на:

```css
    /* Блик по кромке. Именно он, а не размытие, читается как «стекло»:
       размытие даёт глубину, свет даёт материал. У пилюли блик идёт по всему
       периметру, а не только сверху — у оторванной панели «верхней кромки» в
       прежнем смысле нет. Стоит ноль: это тень, а не слой подложки. */
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / .92),
      0 6px 28px rgba(17, 24, 39, .12);
  }
  /* Граница у стекла своя: сплошная линия рамки поперёк размытия выглядит как
     шов, а не как кромка линзы. Наливается вместе со стеклом. */
  .nav-row[data-glass="on"] .nav-surface {
    border-color: rgb(255 255 255 / calc(var(--nav-glass-t) * .55));
  }
```

Второй селектор в `@supports` (`.nav-surface[data-glass="on"]` с `border-top-color`) заменяется этим правилом целиком — `border-top-color` больше не нужен, границу задаёт `border-color`.

- [ ] **Step 4: Убрать «Заявки» из списка вкладок**

В `frontend/src/components/BottomNav.tsx` удалить элемент массива `items` с `to: "/requests"` целиком (объект с иконкой-документом). Дописать над массивом комментарий:

```tsx
/** Четыре вкладки плюс отдельный круг поиска — раскладка Telegram iOS 26.
 *
 *  Заявок здесь больше нет: они переехали в профиль выделенной кнопкой с
 *  бейджем непросмотренных изменений (pages/Profile.tsx). Причина не в
 *  экономии места, а в частоте: в заявки заходят после того, как что-то
 *  заказали, а не по дороге между экранами.
 */
```

- [ ] **Step 5: Пересобрать разметку в ряд из пилюли и круга**

Заменить `className` у `<nav>` на контейнер без собственного фона (`nav-surface` уходит с него на потомков):

```tsx
    <nav
      ref={setNav}
      data-glass="off"
      className="js-bottom-nav nav-row fixed z-40 flex items-center gap-2 lg:hidden">
```

Убраны `inset-x-0`, `bottom-0`, `border-t`, `safe-bottom` и `nav-surface`: позицию задаёт `.nav-row`, форму и фон — потомки, safe-area учтена в `bottom` у `.nav-row` (ровно один раз).

Существующий `<div className="mx-auto flex max-w-md justify-around py-1.5">` становится пилюлей, и следом появляется круг:

```tsx
      <div className="nav-surface nav-pill flex flex-1 justify-around py-1.5">
        {/* ...существующий items.map без изменений... */}
      </div>
      {/* Круг поиска — вторая точка ряда, как у Telegram. Поиск становится
          доступен с КАЖДОГО экрана, а не только с главной и каталога, и
          оказывается под большим пальцем. Маршрут берётся из searchRoutes.ts:
          строка всегда ищет по каталогу, и второго обработчика здесь не
          заводится. */}
      <Link
        to={`${catalogSearchRoute("")}?focus=search`}
        onPointerDown={() => preloadRoute("/catalog")}
        aria-label="Поиск"
        className="nav-surface nav-circle tap flex h-14 w-14 shrink-0 items-center justify-center text-muted"
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
      </Link>
    </nav>
```

Добавить импорт:

```tsx
import { catalogSearchRoute } from "../lib/searchRoutes";
```

Фильтр `nav-refract` (`<svg width="0" height="0">`) остаётся прямо под открывающим `<nav>`, где и был: это определение, а не картинка, и от переезда фона на потомков оно не зависит.

- [ ] **Step 6: Фокусировать строку поиска в каталоге**

В `frontend/src/pages/Catalog.tsx` добавить ref на `<input>` (строка ~292) и эффект. Ref:

```tsx
  const searchRef = useRef<HTMLInputElement>(null);
```

На самом `<input>` добавить `ref={searchRef}`. Эффект — рядом с другими эффектами компонента:

```tsx
  // Круг поиска в нижней навигации ведёт сюда с меткой focus=search: своей
  // страницы у поиска нет, и заводить её ради одной строки означало бы вторую
  // реализацию того, что уже работает в каталоге. Метка снимается сразу после
  // фокуса — иначе возврат назад по истории снова открывал бы клавиатуру.
  useEffect(() => {
    if (params.get("focus") !== "search") return;
    searchRef.current?.focus();
    const next = new URLSearchParams(params);
    next.delete("focus");
    setParams(next, { replace: true });
  }, [params, setParams]);
```

Добавить `useRef` в существующий импорт из `react`.

- [ ] **Step 7: Проверить типы, тесты и сборку**

```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```

Ожидается: без ошибок. `navGlass.test.ts` должен пройти **без правок** — если он падает, форма разошлась с договорённостью: остановиться и вернуться к спеке.

- [ ] **Step 8: Коммит**

```bash
git add frontend/src/components/BottomNav.tsx frontend/src/pages/Catalog.tsx frontend/src/index.css
git commit -m "feat(навигация): плавающая пилюля из четырёх вкладок и круг поиска"
```

---

### Task 5: Счёт непросмотренных изменений

**Files:**
- Modify: `frontend/src/lib/leads.ts`
- Test: `frontend/src/lib/leads.test.ts`

**Interfaces:**
- Consumes: ничего из предыдущих задач.
- Produces: `unseenLeadCount(leads: LeadSeenLike[], lastSeen: string | null): number` и тип `LeadSeenLike = { created_at?: string | null; updated_at?: string | null }`. Task 6 вызывает обе.

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `frontend/src/lib/leads.test.ts`:

```ts
import { unseenLeadCount } from "./leads";

describe("unseenLeadCount", () => {
  const lead = (created: string, updated: string) => ({ created_at: created, updated_at: updated });

  it("считает заявку, которую менеджер тронул после последнего просмотра", () => {
    const leads = [lead("2026-09-01T10:00:00Z", "2026-09-03T12:00:00Z")];
    expect(unseenLeadCount(leads, "2026-09-02T00:00:00Z")).toBe(1);
  });

  it("НЕ считает только что созданную заявку: человек сам её и отправил", () => {
    const leads = [lead("2026-09-03T12:00:00Z", "2026-09-03T12:00:00Z")];
    expect(unseenLeadCount(leads, "2026-09-02T00:00:00Z")).toBe(0);
  });

  it("не считает изменения, которые уже видели", () => {
    const leads = [lead("2026-09-01T10:00:00Z", "2026-09-02T12:00:00Z")];
    expect(unseenLeadCount(leads, "2026-09-03T00:00:00Z")).toBe(0);
  });

  it("без отметки о просмотре бейдж не зажигается на всю историю", () => {
    const leads = [
      lead("2026-09-01T10:00:00Z", "2026-09-02T12:00:00Z"),
      lead("2026-08-01T10:00:00Z", "2026-08-05T12:00:00Z"),
    ];
    expect(unseenLeadCount(leads, null)).toBe(0);
  });

  it("пустой список даёт ноль", () => {
    expect(unseenLeadCount([], "2026-09-02T00:00:00Z")).toBe(0);
  });

  it("битые и отсутствующие даты не считаются изменениями", () => {
    const leads = [
      { created_at: null, updated_at: null },
      { created_at: "2026-09-01T10:00:00Z", updated_at: "не дата" },
    ];
    expect(unseenLeadCount(leads, "2026-09-02T00:00:00Z")).toBe(0);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd frontend && npx vitest run src/lib/leads.test.ts
```

Ожидается: FAIL — `unseenLeadCount is not exported`.

- [ ] **Step 3: Написать функцию**

Дописать в `frontend/src/lib/leads.ts`:

```ts
export type LeadSeenLike = {
  created_at?: string | null;
  updated_at?: string | null;
};

/** Миллисекунды из ISO-строки; null для пустого и для мусора. */
function ms(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Сколько заявок изменилось с последнего захода человека в «Мои заявки».
 *
 *  Условий ДВА, и второе не менее важно первого:
 *
 *  - `updated_at > lastSeen` — с последнего просмотра что-то происходило;
 *  - `updated_at > created_at` — происходившее сделал МЕНЕДЖЕР. Без этого
 *    условия заявка, которую человек только что отправил сам, немедленно
 *    зажигала бы ему бейдж о его собственном действии — то есть бейдж
 *    сообщал бы «у вас новости» ровно в тот момент, когда новостей нет.
 *
 *  `lastSeen === null` (первый запуск, очищенное хранилище) даёт ноль
 *  намеренно. Иначе человек, впервые открывший приложение после обновления,
 *  получил бы бейдж на всю свою историю заявок — цифру, которая ничего не
 *  сообщает и гасится только заходом в раздел.
 *
 *  Даты сравниваются как миллисекунды, а не строками: строковое сравнение ISO
 *  верно лишь пока у всех значений одинаковая зона и одинаковая точность, а
 *  это условие держится ровно до первой смены сериализатора.
 */
export function unseenLeadCount(leads: LeadSeenLike[], lastSeen: string | null): number {
  const seen = ms(lastSeen);
  if (seen === null) return 0;
  let n = 0;
  for (const l of leads) {
    const updated = ms(l.updated_at);
    const created = ms(l.created_at);
    if (updated === null || created === null) continue;
    if (updated > seen && updated > created) n += 1;
  }
  return n;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd frontend && npx vitest run src/lib/leads.test.ts
```

Ожидается: PASS, все шесть.

- [ ] **Step 5: Коммит**

```bash
git add frontend/src/lib/leads.ts frontend/src/lib/leads.test.ts
git commit -m "feat(заявки): счёт непросмотренных изменений статуса"
```

---

### Task 6: Заявки в профиле и бейдж на вкладке

**Files:**
- Create: `frontend/src/store/leadsBadge.ts`
- Modify: `frontend/src/pages/Profile.tsx:28`, `:56-58`, `:161-168`
- Modify: `frontend/src/pages/Requests.tsx:65`
- Modify: `frontend/src/components/BottomNav.tsx` (точка на вкладке «Профиль»)

**Interfaces:**
- Consumes: `unseenLeadCount`, `LeadSeenLike` из Task 5; список вкладок из Task 4.
- Produces: `useLeadsBadge` — zustand-стор с полями `{ total: number | null; unseen: number; refresh(): Promise<void>; markSeen(): void }`.

- [ ] **Step 1: Создать стор**

Создать `frontend/src/store/leadsBadge.ts`:

```ts
/** Счётчик заявок и непросмотренных изменений по ним.
 *
 *  Зачем стор, а не состояние страницы. Цифру показывают ДВА места сразу —
 *  кнопка в профиле и точка на вкладке «Профиль» в нижней навигации, которая
 *  живёт в Layout и переживает переходы между страницами. Пока счёт лежал в
 *  Profile.tsx, второе место могло получить его только собственным запросом:
 *  два обращения к /leads/my на каждый заход в приложение ради одного и того
 *  же числа.
 *
 *  Почему отметка о просмотре в localStorage, а не колонкой в users. Колонка
 *  дала бы синхронизацию между устройствами, но стоила бы мини-миграции и
 *  обязательного добавления в REQUIRED_SCHEMA бота — иначе он падает
 *  UndefinedColumn на первом же деплое. Всё это ради подсветки, которая живёт
 *  до первого открытия раздела, у пользователя, который почти всегда на одном
 *  устройстве. Понадобится синхронизация — поднимем отдельной задачей.
 */
import { create } from "zustand";

import { api } from "../lib/api";
import { unseenLeadCount, type LeadSeenLike } from "../lib/leads";

const SEEN_KEY = "leads_seen_at";

/** Хранилище может быть недоступно (приватный режим, отключённые куки).
 *  Отсутствие отметки — не ошибка: бейдж просто не зажигается. */
function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(iso: string): void {
  try {
    localStorage.setItem(SEEN_KEY, iso);
  } catch {
    /* подсветка — не то, ради чего стоит падать */
  }
}

type LeadsBadgeState = {
  /** Всего заявок. null — ещё не спрашивали. */
  total: number | null;
  /** Изменившихся с последнего просмотра. */
  unseen: number;
  refresh: () => Promise<void>;
  markSeen: () => void;
};

export const useLeadsBadge = create<LeadsBadgeState>((set) => ({
  total: null,
  unseen: 0,
  refresh: async () => {
    try {
      const d = await api<{ leads: LeadSeenLike[] }>("/leads/my");
      set({ total: d.leads.length, unseen: unseenLeadCount(d.leads, readSeen()) });
    } catch {
      // Сбой запроса оставляет счётчик нейтральным. Ошибка в бейдже пугает
      // сильнее, чем отсутствие цифры, — то же правило, что у блока лояльности.
      set({ total: 0, unseen: 0 });
    }
  },
  markSeen: () => {
    writeSeen(new Date().toISOString());
    set({ unseen: 0 });
  },
}));
```

- [ ] **Step 2: Перевести профиль на стор**

В `frontend/src/pages/Profile.tsx` удалить строку 28 (`const [leadCount, setLeadCount] = useState<number | null>(null);`) и эффект строк 56–58 (запрос `/leads/my`). Вместо них:

```tsx
  const leadTotal = useLeadsBadge((s) => s.total);
  const leadUnseen = useLeadsBadge((s) => s.unseen);
  const refreshLeads = useLeadsBadge((s) => s.refresh);
  useEffect(() => { void refreshLeads(); }, [refreshLeads]);
```

Добавить импорт:

```tsx
import { useLeadsBadge } from "../store/leadsBadge";
```

- [ ] **Step 3: Поднять заявки в выделенную кнопку под шапкой**

В `frontend/src/pages/Profile.tsx` удалить строку `<MenuRow icon="doc" title="Мои заявки" .../>` из блока меню (строки 167–168) и вставить перед блоком `{/* Меню */}` (строка 161):

```tsx
      {/* Заявки подняты из общего меню в отдельную кнопку: это единственная
          строка профиля, за которой человек возвращается СПЕЦИАЛЬНО — узнать,
          что ответил менеджер. Остальные пункты открывают справочное, и
          соседство с ними прятало заявки в ряду равных.
          Бейдж считает только изменения, сделанные менеджером после последнего
          захода (lib/leads.ts, unseenLeadCount) — не общее число заявок. */}
      <button
        onClick={() => navigate("/requests")}
        className="tap mt-3 flex w-full items-center gap-3 rounded-xl2 bg-surface px-4 py-4 text-left shadow-soft"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Icon name="doc" className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold">Мои заявки</span>
          <span className="mt-0.5 block truncate text-xs text-muted">
            {leadTotal === null
              ? "Загружаем…"
              : leadTotal === 0
                ? "Здесь появятся ваши обращения"
                : `Всего ${leadTotal}`}
          </span>
        </span>
        {leadUnseen > 0 && (
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-bold text-white">
            {leadUnseen}
          </span>
        )}
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-muted" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
```

- [ ] **Step 4: Гасить бейдж при открытии заявок**

В `frontend/src/pages/Requests.tsx` заменить строку 65 на:

```tsx
    api<{ leads: Lead[] }>("/leads/my")
      .then((d) => {
        setLeads(d.leads);
        // Раздел открыт — изменения по заявкам считаются увиденными. Штампуем
        // ПОСЛЕ успешной загрузки: погасить бейдж на экране, который не смог
        // показать заявки, значит потерять уведомление молча.
        useLeadsBadge.getState().markSeen();
      })
      .catch(() => setError(true));
```

Добавить импорт:

```tsx
import { useLeadsBadge } from "../store/leadsBadge";
```

И объявить `updated_at` в типе `Lead` (строки 13–17) — поле уже приходит с сервера, но во фронтовом типе его нет:

```tsx
  manager_comment: string | null; created_at: string; updated_at: string;
```

- [ ] **Step 5: Точка на вкладке «Профиль»**

В `frontend/src/components/BottomNav.tsx` внутри `BottomNav()` добавить:

```tsx
  const leadUnseen = useLeadsBadge((s) => s.unseen);
  const refreshLeads = useLeadsBadge((s) => s.refresh);
  // Панель живёт в Layout и переживает переходы, поэтому запрос один на сессию,
  // а не на каждый заход в профиль. Профиль читает тот же стор.
  useEffect(() => { void refreshLeads(); }, [refreshLeads]);
```

Добавить импорт:

```tsx
import { useLeadsBadge } from "../store/leadsBadge";
```

И внутри `items.map`, в `<span className={`nav-icon ...`}>`, обернуть его так, чтобы у «Профиля» появлялась точка. Заменить этот `<span>` на:

```tsx
              <span className={`nav-icon relative flex h-7 min-w-10 items-center justify-center rounded-full ${
                isActive ? "nav-icon-active" : ""
              }`}>
                {item.icon(isActive)}
                {/* Точка, а не цифра: в ряду вкладок число нечитаемо мелким, а
                    сообщить надо ровно одно — «там что-то изменилось».
                    Цифра есть в самом профиле, на кнопке заявок. */}
                {item.to === "/profile" && leadUnseen > 0 && (
                  <span className="absolute right-1 top-0 h-2 w-2 rounded-full bg-accent ring-2 ring-surface" />
                )}
              </span>
```

- [ ] **Step 6: Проверить типы, тесты и сборку**

```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```

Ожидается: без ошибок.

- [ ] **Step 7: Коммит**

```bash
git add frontend/src/store/leadsBadge.ts frontend/src/pages/Profile.tsx frontend/src/pages/Requests.tsx frontend/src/components/BottomNav.tsx
git commit -m "feat(профиль): заявки выделенной кнопкой с бейджем непросмотренных"
```

---

### Task 7: Проверка целиком

Отдельной задачей, потому что прогон типов и тестов ничего не говорит о том, ради чего всё делалось.

- [ ] **Step 1: Полный прогон**

```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```

```bash
cd backend && python -m pytest -q
```

Backend не менялся, но прогон подтверждает это, а не предполагает. Ожидается 1105 пройденных.

- [ ] **Step 2: Локальный стенд**

```bash
docker compose -f docker-compose.demo.yml up -d --build frontend
```

Открыть `http://localhost:5173` и проверить глазами:

- главная: пилюля и круг стоят над нижней кромкой, между ними и краем есть зазор;
- карточка товара: кнопка «Оставить заявку» НЕ перекрыта пилюлей и между ними нет сквозной щели;
- корзина: панель корзины стоит над пилюлей, не наезжая;
- профиль: кнопка «Мои заявки» под шапкой, ниже — меню без строки заявок;
- каталог: тап по кругу поиска открывает каталог с фокусом на строке.

- [ ] **Step 3: Прод**

```bash
bash update-server.sh
```

Только из Git Bash. Перед запуском убедиться, что в рабочем дереве нет ничего лишнего: деплой синхронизирует дерево целиком.

- [ ] **Step 4: Живой телефон**

Открыть Mini App с телефона и проверить то, что dev-браузер не воспроизводит:

- знак бренда стоит между «Закрыть» и «⌄ ⋯», не наезжая ни на одну из кнопок;
- нажатие по «Закрыть» работает — знак не перехватил его;
- прокрутка главной и каталога не подтормаживает под пилюлей;
- в углах пилюли нет волосяного шва;
- заголовок главной тает, мелкий проявляется в шапке, две фразы не видны одновременно.

Только после этого работа считается сделанной.

## Порядок и зависимости

Task 1 → Task 2 (второй занимает слот, освобождённый первым).
Task 3 → Task 4 (сначала геометрия низа, потом форма и состав ряда: пилюля позиционируется от зазора, которого до Task 3 нет).
Task 5 → Task 6 (счёт, потом его показ).
Task 7 — после всех.

Ветки 1–2, 3–4 и 5–6 между собой независимы и могут идти в любом порядке.
