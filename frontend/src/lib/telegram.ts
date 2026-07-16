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
