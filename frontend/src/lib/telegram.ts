/** Тонкая обёртка над Telegram WebApp SDK. */

import {
  computeSafeArea,
  formatCssVars,
  isKeyboardOpen,
  pickViewportHeight,
} from "./viewport";

type SafeAreaInset = { top: number; bottom: number; left: number; right: number };

type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
  colorScheme: "light" | "dark";
  isVersionAtLeast?: (version: string) => boolean;
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  disableVerticalSwipes?: () => void;
  openTelegramLink?: (url: string) => void;
  openLink?: (url: string) => void;
  HapticFeedback?: { impactOccurred: (style: string) => void };
  viewportHeight?: number;
  viewportStableHeight?: number;
  isFullscreen?: boolean;
  safeAreaInset?: SafeAreaInset;
  contentSafeAreaInset?: SafeAreaInset;
  themeParams?: Record<string, string>;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
};

export function getTelegram(): TelegramWebApp | null {
  const tg = (window as any)?.Telegram?.WebApp as TelegramWebApp | undefined;
  return tg && tg.initData !== undefined ? tg : null;
}

export function isInsideTelegram(): boolean {
  const tg = getTelegram();
  return !!tg && tg.initData.length > 0;
}

/** Раскрыть Mini App на весь экран.
 *  - expand(): на всю доступную высоту (базовый режим, все версии);
 *  - requestFullscreen(): иммерсивный полноэкранный режим (Telegram Bot API 8.0+);
 *  - disableVerticalSwipes(): чтобы случайный свайп вниз не сворачивал приложение.
 *  Всё в try/catch — на старых клиентах методов может не быть. */
/** Открыть внешнюю ссылку (t.me менеджера и т.п.).
 *  Внутри Telegram t.me-ссылки открываем через openTelegramLink — диалог
 *  откроется в самом Telegram, а не во внешнем браузере. Иначе window.open.
 *  Возвращает false, если url пустой (вызывающий код показывает fallback). */
export function openExternalLink(url: string | null | undefined): boolean {
  const u = (url ?? "").trim();
  if (!u) return false;
  const tg = getTelegram();
  try {
    if (tg && /^https:\/\/t\.me\//i.test(u) && tg.openTelegramLink) {
      tg.openTelegramLink(u);
      return true;
    }
  } catch {}
  window.open(u, "_blank", "noopener");
  return true;
}

/** Тактильный отклик (Telegram HapticFeedback). Вне Telegram/на старых
 *  клиентах — тихий no-op, ошибок не бросает. */
export function haptic(style: "light" | "medium" | "heavy" | "soft" | "rigid" = "light"): void {
  try {
    getTelegram()?.HapticFeedback?.impactOccurred(style);
  } catch {
    /* нет Telegram/HapticFeedback — не мешаем */
  }
}

export function enterFullscreen(): void {
  const tg = getTelegram();
  if (!tg) return;
  try { tg.expand(); } catch {}
  try { tg.disableVerticalSwipes?.(); } catch {}
  try {
    const supported = !tg.isVersionAtLeast || tg.isVersionAtLeast("8.0");
    if (supported) tg.requestFullscreen?.();
  } catch {}
}

/* ============================================================
   Единая инициализация Telegram UI: ready/expand/fullscreen,
   цвета шапки/фона и синхронизация viewport/safe-area → CSS vars.
   Вызывается РОВНО ОДИН РАЗ из App (useEffect с cleanup).
   ============================================================ */

/** Фон приложения (светлая тема Mini App). Приложение не имеет тёмного
 *  редизайна, поэтому шапке/фону Telegram задаётся фон приложения в обеих
 *  темах — иначе в тёмной теме над контентом появляется полоса чужого цвета. */
const APP_BG = "#f6f7f9";
const APP_SURFACE = "#ffffff";

function applyTelegramColors(tg: TelegramWebApp): void {
  try { tg.setHeaderColor?.(APP_BG); } catch {}
  try { tg.setBackgroundColor?.(APP_BG); } catch {}
  try { tg.setBottomBarColor?.(APP_SURFACE); } catch {}
}

/** Прочитать все источники и записать CSS-переменные на <html>.
 *  Источник значений (документация для iOS/Android):
 *  - высота: Telegram viewportStableHeight → viewportHeight →
 *    visualViewport.height → innerHeight → (нет var) CSS 100dvh/100vh;
 *  - safe-area: в Telegram — ТОЛЬКО значения Telegram
 *    (fullscreen: safeAreaInset.top + contentSafeAreaInset.top; обычный
 *    режим: top = 0, webview уже начинается под нативной шапкой);
 *    вне Telegram — ТОЛЬКО env(safe-area-inset-*) как CSS-fallback.
 *  Двойная компенсация исключена конструктивно: env() в fallback'ах
 *  срабатывает лишь когда JS-переменная не установлена. */
function syncViewportVars(tg: TelegramWebApp | null): void {
  const root = document.documentElement;
  const vv = window.visualViewport;

  const height = pickViewportHeight({
    tgViewportStableHeight: tg?.viewportStableHeight ?? null,
    tgViewportHeight: tg?.viewportHeight ?? null,
    visualViewportHeight: vv?.height ?? null,
    windowInnerHeight: window.innerHeight,
  });

  // Именно НЕПУСТОЙ initData: telegram-web-app.js, загруженный в обычном
  // браузере, даёт объект с initData="" — это не Telegram, там должен
  // работать env()-fallback из CSS.
  const inside = !!tg && tg.initData.length > 0;
  const safe = computeSafeArea({
    insideTelegram: inside,
    isFullscreen: !!tg?.isFullscreen,
    tgSafeTop: tg?.safeAreaInset?.top ?? null,
    tgSafeBottom: tg?.safeAreaInset?.bottom ?? null,
    tgContentSafeTop: tg?.contentSafeAreaInset?.top ?? null,
    tgContentSafeBottom: tg?.contentSafeAreaInset?.bottom ?? null,
  });

  const vars = formatCssVars({
    "--app-height": height,
    "--visual-viewport-height": vv?.height ?? null,
    "--tg-viewport-height": tg?.viewportHeight ?? null,
    "--tg-viewport-stable-height": tg?.viewportStableHeight ?? null,
    "--tg-safe-area-top": tg?.safeAreaInset?.top ?? null,
    "--tg-safe-area-bottom": tg?.safeAreaInset?.bottom ?? null,
    "--tg-content-safe-area-top": tg?.contentSafeAreaInset?.top ?? null,
    "--tg-content-safe-area-bottom": tg?.contentSafeAreaInset?.bottom ?? null,
    // Итоговые отступы контента. Вне Telegram НЕ ставятся (null) —
    // в index.css у них env()-fallback.
    "--app-content-top-offset": safe.source === "css-env" ? null : safe.top,
    "--app-safe-bottom": safe.source === "css-env" ? null : safe.bottom,
  });
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }

  root.classList.toggle("tg-fullscreen", !!tg?.isFullscreen);
  root.classList.toggle(
    "kb-open",
    isKeyboardOpen(
      vv?.height ?? tg?.viewportHeight ?? null,
      tg?.viewportStableHeight ?? window.screen?.height ?? null
    )
  );
}

let uiInitialized = false;

/** Инициализация Telegram Mini App UI. Возвращает cleanup для useEffect.
 *  Повторный вызов (React StrictMode) — no-op с пустым cleanup. */
export function initTelegramUi(): () => void {
  if (uiInitialized) return () => {};
  uiInitialized = true;

  const tg = getTelegram();
  try { tg?.ready(); } catch {}
  enterFullscreen(); // expand + guarded requestFullscreen (без retry: отказ просто оставляет обычный режим)
  if (tg) applyTelegramColors(tg);

  // rAF-коалесценция: сколько бы событий ни пришло за кадр — один пересчёт.
  let raf = 0;
  const requestSync = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      syncViewportVars(getTelegram());
    });
  };
  const onTheme = () => {
    const t = getTelegram();
    if (t) applyTelegramColors(t);
    requestSync();
  };

  syncViewportVars(tg); // первый расчёт до первого кадра контента

  const tgEvents = [
    "viewportChanged",
    "safeAreaChanged",
    "contentSafeAreaChanged",
    "fullscreenChanged",
  ];
  for (const e of tgEvents) { try { tg?.onEvent?.(e, requestSync); } catch {} }
  try { tg?.onEvent?.("themeChanged", onTheme); } catch {}

  window.addEventListener("resize", requestSync);
  window.addEventListener("orientationchange", requestSync);
  window.visualViewport?.addEventListener("resize", requestSync);

  return () => {
    uiInitialized = false;
    if (raf) cancelAnimationFrame(raf);
    for (const e of tgEvents) { try { tg?.offEvent?.(e, requestSync); } catch {} }
    try { tg?.offEvent?.("themeChanged", onTheme); } catch {}
    window.removeEventListener("resize", requestSync);
    window.removeEventListener("orientationchange", requestSync);
    window.visualViewport?.removeEventListener("resize", requestSync);
  };
}
