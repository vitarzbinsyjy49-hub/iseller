/** Момент снятия беты и обратный отсчёт до него.
 *
 *  Время объявлено ОДИН раз и только здесь: полоса на главной, её текст и
 *  условие «беты больше нет» должны переключиться одновременно, иначе получим
 *  запущенный магазин с надписью «скоро запуск».
 *
 *  Отсчёт считается по часам устройства. Синхронизацию с сервером сознательно
 *  не делаем: счётчик живёт меньше суток, а расхождение часов ничего не ломает —
 *  ни заявку, ни цену. После нуля полоса исчезает сама, без деплоя.
 */

/** 27 августа 2026, 15:15 по Москве. */
export const LAUNCH_AT = new Date("2026-08-27T15:15:00+03:00");

/** «27 августа в 15:15» — для текста рядом со счётчиком. */
export const LAUNCH_LABEL = "27 августа в 15:15";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Текст остатка и шаг тика.
 *
 * Секунды показываем только в последний час: в Telegram WebView перерисовка
 * раз в секунду весь день — это разряженная батарея ради цифры, на которую
 * никто не смотрит.
 */
export function formatCountdown(msLeft: number): { text: string; tickMs: number } | null {
  if (msLeft <= 0) return null;

  if (msLeft >= DAY) {
    const days = Math.floor(msLeft / DAY);
    return { text: `${days} ${plural(days, "день", "дня", "дней")}`, tickMs: MINUTE };
  }

  if (msLeft >= HOUR) {
    const hours = Math.floor(msLeft / HOUR);
    const minutes = Math.floor((msLeft % HOUR) / MINUTE);
    return { text: `${hours} ч ${minutes} мин`, tickMs: MINUTE };
  }

  const minutes = Math.floor(msLeft / MINUTE);
  const seconds = Math.floor((msLeft % MINUTE) / 1000);
  return { text: `${minutes}:${String(seconds).padStart(2, "0")}`, tickMs: 1000 };
}

/** Запуск уже состоялся? Точка правды для «беты больше нет». */
export function isLaunched(now: Date = new Date()): boolean {
  return now.getTime() >= LAUNCH_AT.getTime();
}
