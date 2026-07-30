import { describe, expect, it } from "vitest";

import {
  type CartItemRow,
  EMPTY_CART,
  canAddToCart,
  clampQuantity,
  newIdempotencyKey,
  nextQuantity,
  pluralItems,
  recalcTotals,
  shouldShowCartBar,
  validateCheckout,
  withTotals,
} from "./cartMath";

function row(over: Partial<CartItemRow> = {}): CartItemRow {
  return {
    id: 1, product_id: 10, sku: "SKU", title: "iPhone", brand: "Apple", category: "смартфоны",
    image: "", price: 1000, added_price: 1000, price_changed: false,
    quantity: 1, line_total: 1000, availability_mode: "in_stock",
    availability_label: "В наличии", availability_note: "", orderable: true, max_quantity: 20,
    ...over,
  };
}

describe("pluralItems", () => {
  it("склоняет «товар» по правилам русского языка", () => {
    expect(pluralItems(1)).toBe("1 товар");
    expect(pluralItems(2)).toBe("2 товара");
    expect(pluralItems(4)).toBe("4 товара");
    expect(pluralItems(5)).toBe("5 товаров");
    expect(pluralItems(21)).toBe("21 товар");
    expect(pluralItems(22)).toBe("22 товара");
  });

  it("11–14 — исключение, а не «11 товар»", () => {
    expect(pluralItems(11)).toBe("11 товаров");
    expect(pluralItems(12)).toBe("12 товаров");
    expect(pluralItems(14)).toBe("14 товаров");
  });
});

describe("canAddToCart", () => {
  it("предзаказ и «под заказ» добавить можно", () => {
    expect(canAddToCart("in_stock")).toBe(true);
    expect(canAddToCart("limited")).toBe(true);
    expect(canAddToCart("preorder")).toBe(true);
    expect(canAddToCart("on_request")).toBe(true);
  });

  it("«нет в наличии» и снятый с публикации — нельзя", () => {
    expect(canAddToCart("out_of_stock")).toBe(false);
    expect(canAddToCart("unavailable")).toBe(false);
    expect(canAddToCart(undefined)).toBe(false);
  });
});

describe("clampQuantity / nextQuantity", () => {
  it("держит количество в допустимых границах", () => {
    expect(clampQuantity(0, 20)).toBe(1);
    expect(clampQuantity(25, 20)).toBe(20);
    expect(clampQuantity(3, 20)).toBe(3);
    expect(clampQuantity(NaN, 20)).toBe(1);
  });

  it("нельзя заказать -> 0", () => {
    expect(clampQuantity(3, 0)).toBe(0);
  });

  it("«−» на единице означает удалить позицию, а не количество 0", () => {
    expect(nextQuantity(1, -1, 20)).toBe(0);
    expect(nextQuantity(2, -1, 20)).toBe(1);
  });

  it("«+» упирается в лимит партии", () => {
    expect(nextQuantity(2, 1, 2)).toBe(2);
    expect(nextQuantity(1, 1, 2)).toBe(2);
  });
});

describe("recalcTotals", () => {
  it("сумма считается по актуальным ценам", () => {
    const totals = recalcTotals([
      row({ id: 1, price: 1000, quantity: 2 }),
      row({ id: 2, product_id: 11, price: 500, quantity: 1 }),
    ]);
    expect(totals.estimated_total).toBe(2500);
    expect(totals.items_count).toBe(3);
    expect(totals.positions_count).toBe(2);
  });

  it("недоступная позиция в сумму НЕ входит и помечает корзину", () => {
    const totals = recalcTotals([
      row({ id: 1, price: 1000, quantity: 1 }),
      row({ id: 2, product_id: 11, price: 9999, quantity: 1, orderable: false,
            availability_mode: "unavailable" }),
    ]);
    expect(totals.estimated_total).toBe(1000);
    expect(totals.items_count).toBe(1);
    expect(totals.positions_count).toBe(2);   // позиция видна, просто не считается
    expect(totals.has_unavailable).toBe(true);
  });

  it("изменившаяся цена поднимает флаг для баннера «Цена обновилась»", () => {
    const totals = recalcTotals([row({ price: 900, added_price: 1000, price_changed: true })]);
    expect(totals.has_price_changes).toBe(true);
  });

  it("пустая корзина — валидное состояние, а не ошибка", () => {
    expect(recalcTotals([])).toEqual({
      positions_count: 0, items_count: 0, estimated_total: 0,
      has_unavailable: false, has_price_changes: false,
    });
  });
});

describe("withTotals", () => {
  it("пересчитывает line_total позиций и итоги разом (оптимистичный UI)", () => {
    const next = withTotals(EMPTY_CART, [row({ price: 1500, quantity: 3, line_total: 0 })]);
    expect(next.items[0].line_total).toBe(4500);
    expect(next.estimated_total).toBe(4500);
    expect(next.items_count).toBe(3);
  });

  it("недоступной позиции обнуляет строку суммы", () => {
    const next = withTotals(EMPTY_CART, [row({ price: 1500, quantity: 2, orderable: false })]);
    expect(next.items[0].line_total).toBe(0);
    expect(next.estimated_total).toBe(0);
  });
});

describe("shouldShowCartBar", () => {
  it("панели нет, пока корзина пуста", () => {
    expect(shouldShowCartBar("/", 0)).toBe(false);
  });

  it("на обычных экранах панель видна", () => {
    expect(shouldShowCartBar("/", 3)).toBe(true);
    expect(shouldShowCartBar("/catalog", 1)).toBe(true);
    expect(shouldShowCartBar("/favorites", 1)).toBe(true);
  });

  it("на самой корзине панель была бы дублем", () => {
    expect(shouldShowCartBar("/cart", 3)).toBe(false);
  });

  it("на карточке товара панель встала бы поверх её собственной CTA", () => {
    expect(shouldShowCartBar("/product/42", 3)).toBe(false);
  });
});

describe("validateCheckout", () => {
  it("телефон обязателен, только когда в Telegram ответить некуда", () => {
    expect(validateCheckout({ phone: "", consent: true, requirePhone: true })).toMatch(/телефон/i);
    expect(validateCheckout({ phone: "", consent: true, requirePhone: false })).toBeNull();
  });

  it("без согласия заявку не отправляем", () => {
    expect(validateCheckout({ phone: "+79990000000", consent: false, requirePhone: true }))
      .toMatch(/соглас/i);
  });

  it("заполненная форма проходит", () => {
    expect(validateCheckout({ phone: "+79990000000", consent: true, requirePhone: true })).toBeNull();
  });
});

describe("newIdempotencyKey", () => {
  it("каждый вызов даёт новый непустой ключ", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
  });
});
