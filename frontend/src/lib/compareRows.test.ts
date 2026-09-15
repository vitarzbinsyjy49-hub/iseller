import { describe, expect, it } from "vitest";
import { columnLabels, compareRows } from "./compareRows";
import type { ProductCard } from "../components/ai/types";

function card(over: Partial<ProductCard> = {}): ProductCard {
  return {
    id: 1, title: "Apple iPhone 17 256 ГБ", brand: "Apple", price: 66000,
    old_price: null, in_stock: true, rating: null, image: "", url: "",
    why: [], buttons: [], ...over,
  };
}

describe("compareRows", () => {
  it("меньше двух товаров сравнивать не с чем", () => {
    expect(compareRows([])).toEqual([]);
    expect(compareRows([card()])).toEqual([]);
  });

  it("больше трёх колонок на телефон не влезает — таблицы нет", () => {
    const four = [1, 2, 3, 4].map((id) => card({ id, price: id * 1000 }));
    expect(compareRows(four)).toEqual([]);
  });

  it("строка выходит, только если значения РАЗНЫЕ", () => {
    const rows = compareRows([card({ id: 1, price: 66000 }), card({ id: 2, price: 88500 })]);
    // Неразрывный пробел внутри числа — так его ставит Intl в formatPrice.
    expect(rows.find((r) => r.label === "Цена")?.values)
      .toEqual(["66 000 ₽", "88 500 ₽"]);
  });

  it("одинаковое значение не показывается: строка без разницы — это шум", () => {
    const rows = compareRows([card({ id: 1, price: 66000 }), card({ id: 2, price: 66000 })]);
    expect(rows.find((r) => r.label === "Цена")).toBeUndefined();
  });

  it("совсем одинаковые товары дают пустую таблицу, а не пустые строки", () => {
    expect(compareRows([card({ id: 1 }), card({ id: 2 })])).toEqual([]);
  });

  it("price_note важнее цены: у предзаказа своей цены ещё не существует", () => {
    const rows = compareRows([
      card({ id: 1, price: 66000 }),
      card({ id: 2, price: 0, price_note: "Цена будет известна позже" }),
    ]);
    expect(rows.find((r) => r.label === "Цена")?.values)
      .toEqual(["66 000 ₽", "Цена будет известна позже"]);
  });

  it("наличие словами, а не булевым значением", () => {
    const rows = compareRows([
      card({ id: 1, in_stock: true }),
      card({ id: 2, in_stock: false }),
    ]);
    expect(rows.find((r) => r.label === "Наличие")?.values).toEqual(["Есть", "Под заказ"]);
  });

  it("рейтинг показывается, когда он есть хотя бы у одного", () => {
    const rows = compareRows([
      card({ id: 1, rating: 4.8 }),
      card({ id: 2, rating: null }),
    ]);
    expect(rows.find((r) => r.label === "Рейтинг")?.values).toEqual(["4,8", "—"]);
  });

  it("состояние показывается, когда товары различаются по нему", () => {
    const rows = compareRows([
      card({ id: 1, condition: "new" }),
      card({ id: 2, condition: "used" }),
    ]);
    expect(rows.find((r) => r.label === "Состояние")?.values).toEqual(["Новый", "Б/у"]);
  });

  it("регион поставки — из кодов, а не из названия", () => {
    const rows = compareRows([
      card({ id: 1, region_codes: ["HK"] }),
      card({ id: 2, region_codes: ["KR", "JP"] }),
    ]);
    expect(rows.find((r) => r.label === "Поставка")?.values).toEqual(["HK", "KR, JP"]);
  });

  it("скидка выходит, когда она есть у одного и нет у другого", () => {
    const rows = compareRows([
      card({ id: 1, old_price: 80000, discount_percent: 18 }),
      card({ id: 2, old_price: null }),
    ]);
    expect(rows.find((r) => r.label === "Скидка")?.values).toEqual(["−18%", "—"]);
  });

  it("порядок строк постоянный: цена первой, дальше по убыванию важности", () => {
    const rows = compareRows([
      card({ id: 1, price: 66000, in_stock: true, rating: 4.8 }),
      card({ id: 2, price: 88500, in_stock: false, rating: 4.2 }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Цена", "Наличие", "Рейтинг"]);
  });
});

describe("columnLabels", () => {
  it("снимает общее начало: колонки должны показывать РАЗНИЦУ", () => {
    expect(columnLabels([
      card({ id: 1, title: "Apple iPhone 17 Pro Max 256 ГБ Orange" }),
      card({ id: 2, title: "Apple iPhone 17 Pro Max 512 ГБ Blue" }),
    ])).toEqual(["256 ГБ Orange", "512 ГБ Blue"]);
  });

  it("общего начала нет — названия остаются целиком", () => {
    expect(columnLabels([
      card({ id: 1, title: "Apple iPhone 17" }),
      card({ id: 2, title: "Dyson V15 Detect" }),
    ])).toEqual(["Apple iPhone 17", "Dyson V15 Detect"]);
  });

  it("одинаковые названия не срезаются в пустоту", () => {
    expect(columnLabels([
      card({ id: 1, title: "Apple iPhone 17" }),
      card({ id: 2, title: "Apple iPhone 17" }),
    ])).toEqual(["Apple iPhone 17", "Apple iPhone 17"]);
  });

  it("срез не оставляет колонку пустой, даже если одно название — начало другого", () => {
    expect(columnLabels([
      card({ id: 1, title: "Apple iPhone 17" }),
      card({ id: 2, title: "Apple iPhone 17 Pro" }),
    ])).toEqual(["Apple iPhone 17", "Apple iPhone 17 Pro"]);
  });

  it("берёт title_clean, когда он есть: коды региона в заголовке не нужны", () => {
    expect(columnLabels([
      card({ id: 1, title: "Apple iPhone 17 256 ГБ (HK-KR)", title_clean: "Apple iPhone 17 256 ГБ" }),
      card({ id: 2, title: "Apple iPhone 17 512 ГБ (HK-KR)", title_clean: "Apple iPhone 17 512 ГБ" }),
    ])).toEqual(["256 ГБ", "512 ГБ"]);
  });
});
