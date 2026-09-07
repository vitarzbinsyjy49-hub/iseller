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
export function cashbackFor(price: number, rateBps: number): number {
  if (!(price > 0) || !(rateBps > 0)) return 0;
  return Math.floor((price * rateBps) / 10000);
}

export const KIND_LABEL: Record<LoyaltyTx["kind"], string> = {
  purchase: "Кэшбек с покупки",
  spend: "Списание баллов",
  bonus: "Бонус от магазина",
  correction: "Корректировка",
  referral: "За приглашение",
};
