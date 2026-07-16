/** Тонкая обёртка над Telegram WebApp SDK. */

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
