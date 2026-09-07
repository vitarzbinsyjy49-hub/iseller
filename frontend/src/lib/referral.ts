/** Экран приглашений: типы и чистый текст условий.
 *
 *  Числа в текст НЕ зашиты: процент и приветственный бонус настраиваются в
 *  админке и приходят с сервера. Строка «1%» в коде разъехалась бы с настройкой
 *  молча — человек читал бы одно, а получал другое.
 *
 *  Роудмап обещает «без условий, которые видно только в конце», поэтому условия
 *  называются полностью и заранее, на самом экране, а не в справке.
 */
import { api } from "./api";

export type ReferralAccount = {
  code: string;
  /** null — бот не настроен: приглашать нечем, и звать к этому не надо. */
  link: string | null;
  invited_count: number;
  earned_points: number;
  rate_percent: number;
  welcome_bonus_points: number;
};

export function fetchReferral(): Promise<ReferralAccount> {
  return api<ReferralAccount>("/referral/me");
}

/** «1%» из 1, «1,5%» из 1.5 — с запятой, как принято в русском. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${String(Math.round(value * 100) / 100).replace(".", ",")}%`;
}

/** Условия программы одной строкой, из чисел сервера.
 *
 *  Порядок частей неслучаен: сначала выгода друга, потом своя. Приглашение,
 *  которое начинается с «я получу процент», человек не отправляет.
 */
export function termsLines(account: Pick<ReferralAccount, "rate_percent" | "welcome_bonus_points">): string[] {
  const lines: string[] = [];
  if (account.welcome_bonus_points > 0) {
    lines.push(`Другу — ${account.welcome_bonus_points.toLocaleString("ru-RU")} баллов за первую покупку`);
  }
  if (account.rate_percent > 0) {
    lines.push(`Вам — ${formatPercent(account.rate_percent)} с каждой его покупки, без срока`);
  }
  lines.push("Баллы приходят после того, как друг забрал заказ");
  return lines;
}
