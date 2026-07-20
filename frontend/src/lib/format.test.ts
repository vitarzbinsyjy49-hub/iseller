import { describe, expect, it } from "vitest";
import { formatPrice, discountPct } from "./format";

// Intl.NumberFormat("ru-RU") группирует разряды через NBSP (код 160), не
// обычным пробелом — визуально неотличимо, но байтово другой символ.
// String.fromCharCode избавляет от зависимости от кодировки исходника.
const NBSP = String.fromCharCode(160);

describe("formatPrice", () => {
  it("groups thousands with a non-breaking space and appends ₽", () => {
    // NBSP только между группами разрядов (из Intl); перед ₽ — обычный
    // пробел, он приходит из литерала " ₽" в самой formatPrice.
    expect(formatPrice(99990)).toBe(`99${NBSP}990 ₽`);
    expect(formatPrice(1234567)).toBe(`1${NBSP}234${NBSP}567 ₽`);
  });

  it("rounds fractional values", () => {
    expect(formatPrice(999.6)).toBe(`1${NBSP}000 ₽`);
  });
});

describe("discountPct", () => {
  it("returns the correct rounded percentage for a real discount", () => {
    expect(discountPct(89990, 99990)).toBe(10);
    expect(discountPct(50000, 100000)).toBe(50);
  });

  // Регрессия: ProductCard/ProductDetails раньше показывали зачёркнутую
  // old_price всегда, когда она просто существовала — даже когда она не
  // больше текущей цены. discountPct() должен вернуть null в этих случаях,
  // и именно эта проверка (`disc !== null`) теперь используется для показа.
  it("returns null when old_price is not actually greater than price", () => {
    expect(discountPct(1000, 1000)).toBeNull(); // равна — скидки нет
    expect(discountPct(1000, 900)).toBeNull();  // старая цена ниже текущей — некорректные данные
  });

  it("returns null when old_price is null or zero", () => {
    expect(discountPct(1000, null)).toBeNull();
    expect(discountPct(1000, 0)).toBeNull();
  });

  it("never returns a negative percentage", () => {
    const pct = discountPct(999, 1000);
    expect(pct).not.toBeNull();
    expect(pct as number).toBeGreaterThanOrEqual(0);
  });
});
