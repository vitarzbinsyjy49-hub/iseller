/** Счёт лояльности: типы и чистая арифметика.
 *
 *  Пороги и ставки сюда НЕ копируются — они приходят из `/api/loyalty/me`.
 *  Вторая копия лестницы во фронте разъехалась бы с бэкендом, и покупатель
 *  увидел бы не тот уровень, по которому ему на самом деле начисляют. Здесь
 *  только то, что действительно принадлежит клиенту: формат и проценты для
 *  прогресс-бара. Всё чистое и тестируется в node, как cartMath.ts.
 */
import { api } from "./api";

export type LoyaltyLevel = {
  key: string;
  title: string;
  threshold: number;
  rate_bps: number;
  rate_percent: number;
  /** Предел начисления с одной покупки, в баллах (= рублях). */
  cap_points: number;
};

/** Условия следующей покупки. Считает сервер: акция зависит от журнала покупок
 *  и от даты, и вторая копия правила во фронте разъехалась бы с первой. */
export type NextPurchase = {
  rate_bps: number;
  rate_percent: number;
  cap_points: number;
  /** Название акции или null. */
  promo: string | null;
  /** Последний день акции, ISO. Без акции — null. */
  promo_until: string | null;
};

export type LoyaltyTx = {
  id: number;
  kind: "purchase" | "spend" | "bonus" | "correction" | "referral";
  points: number;
  amount: number | null;
  rate_bps: number | null;
  comment: string | null;
  created_at: string | null;
};

export type LoyaltyAccount = {
  balance: number;
  lifetime_spent: number;
  level: LoyaltyLevel;
  next_level: LoyaltyLevel | null;
  to_next: number;
  ratio: number;
  history: LoyaltyTx[];
  levels: LoyaltyLevel[];
  next_purchase: NextPurchase;
};

export function fetchLoyalty(): Promise<LoyaltyAccount> {
  return api<LoyaltyAccount>("/loyalty/me");
}

/** Ширина прогресс-бара в процентах.
 *
 *  Небольшой минимум у ненулевого прогресса намеренный: полоска в один пиксель
 *  читается как «ничего не засчитано», хотя покупка уже была. Ноль остаётся
 *  нулём — рисовать прогресс тому, кто ещё не покупал, значит врать.
 */
export function progressPercent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 1) return 100;
  return Math.max(4, Math.round(ratio * 100));
}

/** «1 балл», «3 балла», «250 баллов» — русские числительные. */
export function pointsWord(points: number): string {
  const n = Math.abs(Math.trunc(points));
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return "баллов";
  switch (n % 10) {
    case 1: return "балл";
    case 2:
    case 3:
    case 4: return "балла";
    default: return "баллов";
  }
}

export function formatPoints(points: number): string {
  return `${Math.trunc(points).toLocaleString("ru-RU")} ${pointsWord(points)}`;
}

/** Ставка человеку: «0,25%», а не «0.25%».
 *
 *  Точка в дробях — англоязычная запись; рядом с ценами, которые магазин уже
 *  печатает по-русски («119 990 ₽»), она читается как опечатка. */
export function formatRate(rateBps: number): string {
  return `${(rateBps / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
}

/** Сколько рублей скидки даёт кэшбек на конкретной цене — то, ради чего
 *  уровень вообще существует. Округление ВНИЗ, как на сервере: обещать
 *  больше, чем начислится, нельзя. */
export function cashbackFor(price: number, rateBps: number, capPoints?: number): number {
  if (!(price > 0) || !(rateBps > 0)) return 0;
  const points = Math.floor((price * rateBps) / 10000);
  // Потолок обязателен везде, где число показывается человеку: обещать 3000 и
  // начислить 1500 хуже, чем не обещать ничего.
  if (capPoints != null && points > capPoints) return capPoints;
  return points;
}

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** «1 ноября» из ISO-даты. Пустая строка, если дату не разобрать. */
function humanDate(iso: string): string {
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return "";
  const [, month, day] = parts;
  const name = MONTHS[month - 1];
  return name ? `${day} ${name}` : "";
}

/** Условия следующей покупки одной строкой.
 *
 *  Ставка и потолок называются ВМЕСТЕ и всегда. Ставка без потолка — полуправда:
 *  человек посчитает 3% от ста тысяч, получит три тысячи и решит, что его
 *  обманули. Срок показывается только у акции — у постоянной ставки срока нет.
 */
export function nextPurchaseLine(terms: NextPurchase): string {
  const rate = formatRate(terms.rate_bps);
  const cap = `${terms.cap_points.toLocaleString("ru-RU")} ₽`;
  if (!terms.promo) return `Кэшбек ${rate} с покупки, не больше ${cap}`;
  const until = terms.promo_until ? humanDate(terms.promo_until) : "";
  const tail = until ? ` — до ${until}` : "";
  return `Первая покупка — ${rate} кэшбека, не больше ${cap}${tail}`;
}

export const KIND_LABEL: Record<LoyaltyTx["kind"], string> = {
  purchase: "Кэшбек с покупки",
  spend: "Списание баллов",
  bonus: "Бонус от магазина",
  correction: "Корректировка",
  referral: "За приглашение",
};
