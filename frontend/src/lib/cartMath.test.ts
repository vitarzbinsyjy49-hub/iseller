import { describe, expect, it } from "vitest";

import {
  type CartItemRow,
  EMPTY_CART,
  availabilityText,
  availabilityTone,
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

describe("availabilityText", () => {
  it("предзаказ не выдаёт себя за «В наличии»", () => {
    // Регрессия: у предзаказа in_stock=true, и карточка писала «В наличии»,
    // хотя в корзине тот же товар помечался предзаказом.
    expect(availabilityText({ availability_mode: "preorder", in_stock: true })).toBe("Предзаказ");
    expect(availabilityTone({ availability_mode: "preorder", in_stock: true })).toBe("text-muted");
  });

  it("«под заказ», «нет в наличии» и «недоступен» названы своими именами", () => {
    expect(availabilityText({ availability_mode: "on_request", in_stock: false })).toBe("Под заказ");
    expect(availabilityText({ availability_mode: "out_of_stock", in_stock: false })).toBe("Нет в наличии");
    expect(availabilityText({ availability_mode: "unavailable", in_stock: false })).toBe("Недоступен");
  });

  it("«сегодня» в подпись не попадает — она про наличие, и только", () => {
    // Раньше к «В наличии» приписывалось «· Сегодня». Пока флаг стоял у
    // единиц, это была полезная пометка; когда его получили все товары в
    // наличии, приписка оказалась на каждой карточке и перестала что-либо
    // сообщать. Срок получения живёт на карточке товара, в блоке условий.
    expect(availabilityText({ availability_mode: "in_stock", in_stock: true })).toBe("В наличии");
    expect(availabilityTone({ availability_mode: "in_stock" })).toBe("text-green");

    // Через переменную, а не литералом: карточка приходит с сервера со ВСЕМИ
    // полями, включая is_available_today, и проверять надо именно такой объект
    // — что наличие флага на подпись не влияет. Литерал бы отверг компилятор
    // (лишнее свойство), и вместе с ним пропал бы сам страж.
    const flagged = { availability_mode: "limited" as const, in_stock: true, is_available_today: true };
    expect(availabilityText(flagged)).toBe("В наличии");
    expect(availabilityText({ ...flagged, availability_mode: undefined })).toBe("В наличии");
  });

  it("ответ без режима читается по in_stock — старые данные не меняют смысл", () => {
    expect(availabilityText({ in_stock: true })).toBe("В наличии");
    expect(availabilityText({ in_stock: false })).toBe("Под заказ");
    expect(availabilityTone({ in_stock: false })).toBe("text-muted");
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

  it("на экране AI панель перекрывала бы строку ввода", () => {
    // Та же причина, что у карточки товара: внизу уже стоит своя фиксированная
    // панель — поле ввода вопроса. Две всплывающие панели встают друг на друга,
    // и написать AI становится невозможно, пока в корзине что-то лежит.
    expect(shouldShowCartBar("/ai", 3)).toBe(false);
    expect(shouldShowCartBar("/ai?q=iphone", 3)).toBe(false);
  });
});

describe("validateCheckout", () => {
  it("телефон обязателен, только когда в Telegram ответить некуда", () => {
    expect(validateCheckout({ phone: "", consent: true, requirePhone: true }))
      .toMatchObject({ field: "phone", message: expect.stringMatching(/телефон/i) });
    expect(validateCheckout({ phone: "", consent: true, requirePhone: false })).toBeNull();
  });

  it("без согласия заявку не отправляем", () => {
    expect(validateCheckout({ phone: "+79990000000", consent: false, requirePhone: true }))
      .toMatchObject({ field: "consent", message: expect.stringMatching(/соглас/i) });
  });

  it("заполненная форма проходит", () => {
    expect(validateCheckout({ phone: "+79990000000", consent: true, requirePhone: true })).toBeNull();
  });

  // Поле в ответе — не украшение: по нему форма ставит фокус и подпись ошибки
  // ПОД нужным полем. Пока ответом была голая строка, обе формы показывали
  // ошибку одним абзацем над кнопкой, и на длинной форме было неясно, что чинить.
  it("называет поле, на котором споткнулись", () => {
    const problem = validateCheckout({ phone: "", consent: false, requirePhone: true });
    expect(problem?.field).toBe("phone");
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
