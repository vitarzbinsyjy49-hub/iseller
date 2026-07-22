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

/** Клавиатура «открыта», если текущая высота заметно меньше стабильной.
 *  Порог 150px отсекает адресные строки/мелкие изменения. */
export function isKeyboardOpen(
  currentHeight: number | null,
  stableHeight: number | null
): boolean {
  if (!currentHeight || !stableHeight) return false;
  return stableHeight - currentHeight > 150;
}

/** Метрики нижнего стека страницы товара (v5.2.7): фиксированная CTA «Оставить
 *  заявку» стоит НАД нижней навигацией без наезда. Единственный числовой контракт,
 *  который дублирует расчёт index.css (--cta-bottom, .pb-cta) — держим синхронно и
 *  проверяем тестом: раньше CTA имела хардкод bottom:64px, а навбар (≈71px без
 *  выреза, ≈97px на iPhone с home indicator) наезжал на неё.
 *
 *  effSafe = max(8, safeBottom) — тот же max(0.5rem, …), что и на самой навигации
 *  (.safe-bottom): safe-area учитывается РОВНО ОДИН раз, и в навбаре, и в позиции CTA.
 *    navHeight        — полная высота навбара (контент + его safe-inset);
 *    ctaBottomOffset  — CSS bottom фиксированной CTA (= --cta-bottom);
 *    clearance        — зазор CTA↔навбар: всегда 16px в любой safe-area;
 *    contentPadBottom — .pb-cta: чтобы контент не уходил под CTA. */
export function bottomNavStack(safeBottom: number): {
  navHeight: number;
  ctaBottomOffset: number;
  clearance: number;
  contentPadBottom: number;
} {
  const NAV_CONTENT = 64; // --bottom-nav-content
  const CLEARANCE = 16; // зазор CTA↔навбар
  const CTA_AIR = 92; // .pb-cta = --cta-bottom + 92px (высота CTA ~81px + воздух)
  const safe = Number.isFinite(safeBottom) && safeBottom > 0 ? safeBottom : 0;
  const effSafe = Math.max(8, safe); // max(0.5rem, safe) — один раз
  const navHeight = NAV_CONTENT + effSafe;
  const ctaBottomOffset = NAV_CONTENT + effSafe + CLEARANCE;
  return {
    navHeight,
    ctaBottomOffset,
    clearance: ctaBottomOffset - navHeight,
    contentPadBottom: ctaBottomOffset + CTA_AIR,
  };
}

/** Вычисляемый класс внутреннего отступа фото по реальным пропорциям:
 *  почти квадратные фото получают обычный отступ, сильно вытянутые —
 *  уменьшенный, чтобы длинная сторона использовала максимум контейнера.
 *  Никаких ручных списков SKU. */
export function imagePaddingClass(
  naturalWidth: number,
  naturalHeight: number
): "p-2" | "p-1" {
  if (naturalWidth <= 0 || naturalHeight <= 0) return "p-2";
  const ratio = naturalHeight / naturalWidth;
  return ratio >= 1.5 || ratio <= 1 / 1.5 ? "p-1" : "p-2";
}
