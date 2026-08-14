/** Тонкая обёртка над Telegram WebApp SDK. */

import { safeExternalUrl } from "./route";
import {
  computeSafeArea,
  formatCssVars,
  isKeyboardOpen,
  pickViewportHeight,
} from "./viewport";

type SafeAreaInset = { top: number; bottom: number; left: number; right: number };

type TelegramWebApp = {
  initData: string;
  // Патч 2.0: startapp-запуск (t.me/<bot>/<app>?startapp=<payload>) — Mini App
  // открывается СРАЗУ, минуя чат с ботом; payload приходит сюда, а не в
  // текстовое сообщение (см. getStartParam/startParamFrom ниже).
  initDataUnsafe?: { start_param?: string };
  ready: () => void;
  expand: () => void;
  colorScheme: "light" | "dark";
  isVersionAtLeast?: (version: string) => boolean;
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  disableVerticalSwipes?: () => void;
  openTelegramLink?: (url: string) => void;
  openLink?: (url: string) => void;
  // Bot API 8.0: ярлык Mini App на домашнем экране телефона.
  addToHomeScreen?: () => void;
  checkHomeScreenStatus?: (cb: (status: string) => void) => void;
  HapticFeedback?: { impactOccurred: (style: string) => void };
  BackButton?: {
    show?: () => void;
    hide?: () => void;
    onClick?: (handler: () => void) => void;
    offClick?: (handler: () => void) => void;
  };
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

/** Payload из startapp-запуска, или null. Чистая функция (tg — аргумент), по
 *  тому же паттерну, что applyTelegramColors — тестируется без DOM. */
export function startParamFrom(tg: Pick<TelegramWebApp, "initDataUnsafe"> | null): string | null {
  const raw = tg?.initDataUnsafe?.start_param;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function getStartParam(): string | null {
  return startParamFrom(getTelegram());
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
  // v5.4.2: пропускаем только http/https. Ссылка приходит из конфигурации
  // (MANAGER_*), и `javascript:`/`data:` тут исполняться не должны; невалидная
  // ссылка ведёт себя как пустая -> вызывающий код показывает свой fallback.
  const u = safeExternalUrl(url);
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

/** Нативная кнопка «Назад» в шапке Telegram.
 *
 *  Показываем её ровно на тех экранах, откуда есть куда вернуться (вложенные
 *  экраны), и прячем на корневых вкладках — иначе кнопка обещает переход,
 *  которого нет. Возвращает функцию снятия: обработчик обязательно нужно
 *  отцеплять, иначе после нескольких переходов на одно нажатие сработает
 *  несколько устаревших обработчиков.
 *
 *  handler = null => кнопку спрятать. Вне Telegram — тихий no-op. */
export function setBackButton(handler: (() => void) | null): () => void {
  const btn = getTelegram()?.BackButton;
  if (!btn) return () => {};
  if (!handler) {
    try { btn.hide?.(); } catch {}
    return () => {};
  }
  try {
    btn.onClick?.(handler);
    btn.show?.();
  } catch {}
  return () => {
    try { btn.offClick?.(handler); } catch {}
    try { btn.hide?.(); } catch {}
  };
}

/* ================= Ярлык на домашнем экране (Bot API 8.0) ================= */

/** Что Telegram знает про ярлык нашего Mini App.
 *  - `unsupported` — клиент старый или платформа не умеет (desktop, web);
 *  - `added` — ярлык уже стоит;
 *  - `missed` — можно предложить добавить;
 *  - `unknown` — Telegram не берётся ответить. */
export type HomeScreenStatus = "unsupported" | "added" | "missed" | "unknown";

const HOME_SCREEN_STATUSES: HomeScreenStatus[] = ["unsupported", "added", "missed", "unknown"];

/** Узнать состояние ярлыка.
 *
 *  Ответ приходит колбэком, поэтому оборачиваем в Promise. Таймаут обязателен:
 *  на клиенте, который метод объявил, но колбэк не вызывает, Promise повис бы
 *  навсегда, а с ним — и состояние кнопки в интерфейсе.
 *
 *  Любая неопределённость трактуется как `unsupported`: показать кнопку,
 *  которая ничего не делает, хуже, чем не показать её вовсе.
 */
export function checkHomeScreenStatus(timeoutMs = 1500): Promise<HomeScreenStatus> {
  const tg = getTelegram();
  if (!tg?.checkHomeScreenStatus) return Promise.resolve("unsupported");
  // Версию проверяем ДО вызова, хотя try/catch ниже и так его переживёт: SDK
  // на старом клиенте печатает в консоль собственную ошибку «Method ... is not
  // supported in version 6.0» ещё до того, как бросить исключение. Перехватить
  // её нельзя, а профиль открывают часто — консоль забивалась бы шумом, в
  // котором потом не видно настоящих ошибок. Ярлык на домашний экран появился
  // в Bot API 8.0, спрашивать раньше не о чем.
  try {
    if (tg.isVersionAtLeast && !tg.isVersionAtLeast("8.0")) return Promise.resolve("unsupported");
  } catch {
    return Promise.resolve("unsupported");
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: HomeScreenStatus) => {
      if (done) return;
      done = true;
      resolve(status);
    };
    const timer = window.setTimeout(() => finish("unsupported"), timeoutMs);
    try {
      tg.checkHomeScreenStatus!((status) => {
        window.clearTimeout(timer);
        finish(
          HOME_SCREEN_STATUSES.includes(status as HomeScreenStatus)
            ? (status as HomeScreenStatus)
            : "unknown",
        );
      });
    } catch {
      window.clearTimeout(timer);
      finish("unsupported");
    }
  });
}

/** Предложить добавить ярлык. Диалог показывает сам Telegram — согласие
 *  пользователя запрашивает он, не мы. Возвращает false, если метода нет. */
export function addToHomeScreen(): boolean {
  const tg = getTelegram();
  if (!tg?.addToHomeScreen) return false;
  try {
    tg.addToHomeScreen();
    return true;
  } catch {
    return false;
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

/** Нижний бар приложения — светлый (Mini App без тёмного редизайна). А ВОТ ФОН
 *  Telegram (setBackgroundColor) и шапку красим цветом hero (readHeaderColor):
 *  системная область (в fullscreen — зона статус-бара) сливается с hero в единый
 *  тёмный верх на весь экран, без белой полосы. Раньше фон был светлым (#f6f7f9),
 *  из-за чего верх «светился белым». Тему/контент это НЕ трогает. */
const APP_SURFACE = "#ffffff";
// Дублирует --app-header-color из index.css — фолбэк, если переменная ещё не
// посчитана (очень ранний вызов) или DOM недоступен (юнит-тесты).
const HERO_HEADER_FALLBACK = "#14304d";

/** Единый цвет верха: читаем CSS-переменную --app-header-color (тот же токен,
 *  что красит hero) — чтобы шапка Telegram и hero не расходились по цвету.
 *  Пусто / нет DOM → фолбэк-константа. */
export function readHeaderColor(): string {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--app-header-color")
      .trim();
    if (v) return v;
  } catch {}
  return HERO_HEADER_FALLBACK;
}

type TgColorSetters = Pick<
  TelegramWebApp,
  "setHeaderColor" | "setBackgroundColor" | "setBottomBarColor"
>;

/** Применить цвета к хрому Telegram. Каждый сеттер защищён: на старом клиенте
 *  метода может не быть (или он бросит) — тихо пропускаем, следующие всё равно
 *  выполняются. Чистая функция (tg — аргумент): тестируется без DOM. */
export function applyTelegramColors(
  tg: TgColorSetters,
  colors: { header: string; background: string; bottomBar: string },
): void {
  try { tg.setHeaderColor?.(colors.header); } catch {}
  try { tg.setBackgroundColor?.(colors.background); } catch {}
  try { tg.setBottomBarColor?.(colors.bottomBar); } catch {}
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
  const paintChrome = (t: TelegramWebApp) =>
    applyTelegramColors(t, { header: readHeaderColor(), background: readHeaderColor(), bottomBar: APP_SURFACE });
  if (tg) paintChrome(tg);

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
    if (t) paintChrome(t);
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
