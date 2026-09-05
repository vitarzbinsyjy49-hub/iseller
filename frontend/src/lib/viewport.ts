/** Чистая логика расчёта высоты приложения и safe-area отступов.
 *
 *  Единственное место, где решается:
 *  - какой источник высоты использовать (Telegram → visualViewport → CSS);
 *  - какие safe-area отступы применить (Telegram ИЛИ env(), никогда сумма обоих).
 *
 *  Все функции чистые — тестируются в node без DOM (vitest.config.ts).
 */

export type ViewportSources = {
  /** Telegram.WebApp.viewportStableHeight — высота без учёта анимаций раскрытия. */
  tgViewportStableHeight?: number | null;
  /** Telegram.WebApp.viewportHeight — текущая высота Mini App. */
  tgViewportHeight?: number | null;
  /** window.visualViewport.height. */
  visualViewportHeight?: number | null;
  /** window.innerHeight — последний JS-fallback перед CSS 100dvh/100vh. */
  windowInnerHeight?: number | null;
};

/** Выбор высоты приложения по приоритету надёжности:
 *  1) Telegram viewportStableHeight; 2) Telegram viewportHeight;
 *  3) visualViewport.height; 4) window.innerHeight; 5) null → CSS fallback
 *  (var(--app-height) не ставится, работает 100dvh/100vh из index.css). */
export function pickViewportHeight(s: ViewportSources): number | null {
  const candidates = [
    s.tgViewportStableHeight,
    s.tgViewportHeight,
    s.visualViewportHeight,
    s.windowInnerHeight,
  ];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return null;
}

export type SafeAreaSources = {
  insideTelegram: boolean;
  /** Telegram.WebApp.isFullscreen (Bot API 8.0+); вне fullscreen webview
   *  начинается ниже нативной шапки Telegram и отступ сверху не нужен. */
  isFullscreen: boolean;
  /** Telegram.WebApp.safeAreaInset — системная safe area устройства (чёлка/статус-бар). */
  tgSafeTop?: number | null;
  tgSafeBottom?: number | null;
  /** Telegram.WebApp.contentSafeAreaInset — зона, занятая UI самого Telegram
   *  (плавающие кнопки Закрыть/меню в fullscreen). Отсчитывается ОТ safe area,
   *  поэтому в fullscreen итог = safeTop + contentSafeTop (зоны не пересекаются). */
  tgContentSafeTop?: number | null;
  tgContentSafeBottom?: number | null;
};

export type SafeAreaResult = {
  top: number;
  bottom: number;
  /** Откуда взяты значения — для отладки и тестов на отсутствие двойного счёта. */
  source: "telegram-fullscreen" | "telegram" | "css-env";
};

const nz = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

/** Итоговые safe-area отступы контента. Ровно один источник:
 *  - вне Telegram → CSS env(safe-area-inset-*) (JS переменные не ставятся,
 *    в index.css у padding есть env-fallback);
 *  - в Telegram НЕ fullscreen → 0 сверху (нативная шапка Telegram находится
 *    вне webview, компенсировать нечего), снизу — только contentSafeBottom;
 *  - в Telegram fullscreen → safeTop + contentSafeTop (см. SafeAreaSources).
 *  env() к telegram-значениям НИКОГДА не прибавляется. */
export function computeSafeArea(s: SafeAreaSources): SafeAreaResult {
  if (!s.insideTelegram) return { top: 0, bottom: 0, source: "css-env" };
  if (s.isFullscreen) {
    return {
      top: nz(s.tgSafeTop) + nz(s.tgContentSafeTop),
      bottom: Math.max(nz(s.tgSafeBottom), nz(s.tgContentSafeBottom)),
      source: "telegram-fullscreen",
    };
  }
  return {
    top: nz(s.tgContentSafeTop),
    bottom: Math.max(nz(s.tgSafeBottom), nz(s.tgContentSafeBottom)),
    source: "telegram",
  };
}

/** Число → CSS px. null → переменную надо удалить (сработает CSS-fallback). */
export function formatCssVars(
  vars: Record<string, number | null>
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(vars)) {
    out[k] = typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)}px` : null;
  }
  return out;
}

/** Максимальная высота шторки (доля от высоты приложения) — 88% в один
 *  столбец, 90% от sm и шире (та же граница, что у Tailwind `sm:`, 640px). */
export function sheetMaxHeightPx(appHeightPx: number, wide: boolean): number {
  return appHeightPx * (wide ? 0.9 : 0.88);
}

/** Высота выпадающей панели (поиск на главной, popover в desktop-шапке).
 *
 *  Меряется от ВИДИМОЙ высоты, а не от vh. Это не придирка: vh не знает про
 *  клавиатуру, и панель, ограниченная 60vh, при открытой клавиатуре уходила
 *  под неё нижним краем. Прокрутка внутри панели не спасала — последняя строка
 *  («Спросить AI») оставалась в области, которую закрывает клавиатура, то есть
 *  до неё нельзя было добраться вообще никак.
 *
 *  `panelTop` — верхняя кромка панели относительно видимой области.
 *  `bottomGap` — зазор, чтобы панель не упиралась в клавиатуру вплотную.
 *  `min` — на сколько бы ни сжалась видимая область, панель не схлопывается:
 *  слишком узкая полоска бесполезнее короткого списка с прокруткой.
 */
export function dropdownMaxHeightPx(
  panelTop: number,
  viewportHeight: number,
  bottomGap = 12,
  min = 180,
): number {
  const available = viewportHeight - panelTop - bottomGap;
  return Math.round(Math.max(min, available));
}

/** Клавиатура «открыта», если текущая высота заметно меньше стабильной.
 *  Порог 150px отсекает адресные строки/мелкие изменения. */
export function isKeyboardOpen(
  currentHeight: number | null,
  stableHeight: number | null
): boolean {
  if (!currentHeight || !stableHeight) return false;
  return stableHeight - currentHeight > 150;
}

/** Метрики нижнего стека (v5.2.7 / фикс v5.2.7.1): фикс. нижняя панель (CTA товара /
 *  строка ввода AI) прижата к низу (.cta-dock), её кнопка стоит на 16px ВЫШЕ нижней
 *  навигации, а непрозрачный фон панели идёт до самого низа — без наезда и без
 *  сквозной щели над навбаром. Единственный числовой контракт, дублирующий index.css
 *  (--bottom-nav-height, .cta-dock, .pb-cta) — держим синхронно и проверяем тестом.
 *
 *  effSafe = max(8, safeBottom) — тот же max(0.5rem, …), что и на самой навигации
 *  (.safe-bottom): safe-area учитывается РОВНО ОДИН раз, и в высоте навбара, и в
 *  подъёме кнопки.
 *    navHeight        — полная высота навбара (контент + его safe-inset);
 *    ctaBottomOffset  — нижняя кромка кнопки над низом вьюпорта (= navHeight + 16);
 *    clearance        — зазор кнопка↔навбар: всегда 16px в любой safe-area;
 *    contentPadBottom — .pb-cta: чтобы контент не уходил под панель;
 *    navContentPadBottom — .pb-nav: отступ контента под фиксированной навигацией
 *                        (= navHeight + 12px буфер), safe-area считается один раз. */
export function bottomNavStack(safeBottom: number): {
  navHeight: number;
  ctaBottomOffset: number;
  clearance: number;
  contentPadBottom: number;
  navContentPadBottom: number;
} {
  const NAV_CONTENT = 64; // --bottom-nav-content
  // Зазор под плавающей пилюлей. Ровно то же число, что --nav-float-gap в
  // index.css: эта функция — зеркало CSS-геометрии, и расхождение здесь не
  // «неточность», а тест, который врёт про прод.
  const FLOAT_GAP = 10;
  const CLEARANCE = 16; // подъём кнопки над навбаром
  const NAV_CONTENT_PAD = 12; // буфер контента под навигацией (был захардкожен в 76px = 64 + 12)
  const CTA_AIR = 80; // .pb-cta = ctaBottomOffset + 80 (бар над кнопкой ~64px + воздух)
  const safe = Number.isFinite(safeBottom) && safeBottom > 0 ? safeBottom : 0;
  const effSafe = Math.max(8, safe); // max(0.5rem, safe) — один раз
  const navHeight = NAV_CONTENT + effSafe + FLOAT_GAP;
  const ctaBottomOffset = navHeight + CLEARANCE;
  return {
    navHeight,
    ctaBottomOffset,
    clearance: ctaBottomOffset - navHeight,
    contentPadBottom: ctaBottomOffset + CTA_AIR,
    navContentPadBottom: navHeight + NAV_CONTENT_PAD,
  };
}

/** Вычисляемый класс внутреннего отступа фото по реальным пропорциям:
 *  почти квадратные фото получают обычный отступ, сильно вытянутые —
 *  уменьшенный, чтобы длинная сторона использовала максимум контейнера.
 *  Никаких ручных списков SKU. */
export function imagePaddingClass(
  naturalWidth: number,
  naturalHeight: number
): "p-3" | "p-2" {
  if (naturalWidth <= 0 || naturalHeight <= 0) return "p-3";
  const ratio = naturalHeight / naturalWidth;
  return ratio >= 1.5 || ratio <= 1 / 1.5 ? "p-2" : "p-3";
}

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
