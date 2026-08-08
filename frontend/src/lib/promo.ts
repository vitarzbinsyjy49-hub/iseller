/** Промокод в корзине.
 *
 *  Скидку здесь НЕ считаем — её считает сервер и присылает готовой. Второе
 *  место, где выводится сумма, однажды разойдётся с первым, и разойдётся оно на
 *  глазах у покупателя: на экране одна цифра, в заявке другая. Тут только
 *  нормализация ввода, хранение применённого кода между заходами и подписи.
 */
import { api } from "./api";

const STORAGE_KEY = "techshop_promo";

/** Тот же предел и алфавит, что на сервере (`services/promo.py`). */
export const MAX_CODE_LENGTH = 32;
const CODE_RE = /^[A-Z0-9_-]+$/;

export type PromoOffer = {
  code: string;
  discount: number;
  subtotal: number;
  total: number;
  currency: string;
};

/** Код к каноническому виду: человек набирает «start20» и « START20 ». */
export function normalizeCode(raw: string): string {
  return (raw || "").trim().toUpperCase();
}

/** Ошибка ввода или null. Проверяем только форму — действует код или нет,
 *  знает сервер, и спрашиваем это у него. */
export function validateCode(raw: string): string | null {
  const code = normalizeCode(raw);
  if (!code) return "Введите промокод";
  if (code.length > MAX_CODE_LENGTH) return "Такого промокода не существует";
  if (!CODE_RE.test(code)) return "В промокоде только латиница, цифры и дефис";
  return null;
}

/** Проверить код на текущей корзине. Купон при этом НЕ тратится — списание
 *  происходит только при оформлении заявки. */
export async function previewPromo(code: string): Promise<PromoOffer> {
  return api<PromoOffer>("/cart/promo", {
    method: "POST",
    body: JSON.stringify({ code: normalizeCode(code) }),
  });
}

/** Применённый код переживает перезагрузку — как и сама корзина. Хранится
 *  только строка: скидку заново подтвердит сервер, а устаревшая цифра в
 *  localStorage обманула бы человека. */
export function loadSavedCode(): string {
  try {
    return normalizeCode(localStorage.getItem(STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

export function saveCode(code: string): void {
  try {
    const value = normalizeCode(code);
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Приватный режим — просто не запоминаем. Ронять корзину из-за этого нельзя.
  }
}

export function forgetCode(): void {
  saveCode("");
}

/** Итог со скидкой. Нужен, только пока сервер не ответил (оптимистичный показ
 *  уже подтверждённого кода на обновлённой корзине); ниже нуля не уходит. */
export function totalWithDiscount(subtotal: number, discount: number): number {
  return Math.max(0, Math.round((subtotal - discount) * 100) / 100);
}

/** Годится ли ранее применённый код для текущей суммы: если корзина изменилась
 *  так, что скидка больше неё, показывать старую цифру нельзя. */
export function cappedDiscount(subtotal: number, discount: number): number {
  return Math.max(0, Math.min(discount, subtotal));
}
