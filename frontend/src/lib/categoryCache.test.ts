import { describe, expect, it } from "vitest";
import { sanitizeCategories } from "./categoryCache";

/** Кэш существует ради мгновенной отрисовки, но не должен воскрешать плитки,
 *  за которыми нет товаров — ровно этим был плох прежний захардкоженный список. */
describe("sanitizeCategories", () => {
  const ok = { key: "смартфоны", label: "Смартфоны", icon: "📱", count: 46 };

  it("пропускает валидную категорию", () => {
    expect(sanitizeCategories([ok])).toEqual([ok]);
  });

  it("выбрасывает категории без товаров", () => {
    const got = sanitizeCategories([ok, { key: "dyson", label: "Dyson", icon: "💨", count: 0 }]);
    expect(got.map((c) => c.key)).toEqual(["смартфоны"]);
  });

  it("выбрасывает записи без ключа или подписи", () => {
    expect(sanitizeCategories([
      { key: "", label: "Пусто", icon: "x", count: 5 },
      { key: "часы", label: "", icon: "x", count: 5 },
    ])).toEqual([]);
  });

  it("дедуплицирует по ключу", () => {
    expect(sanitizeCategories([ok, { ...ok, label: "Дубль" }])).toHaveLength(1);
  });

  it("подставляет иконку по умолчанию", () => {
    const [c] = sanitizeCategories([{ key: "умный дом", label: "Умный дом", count: 3 }]);
    expect(c.icon).toBe("🛍️");
  });

  it("не падает на мусоре вместо массива", () => {
    for (const bad of [null, undefined, 42, "строка", {}]) {
      expect(sanitizeCategories(bad)).toEqual([]);
    }
  });

  it("не падает на мусоре внутри массива", () => {
    expect(sanitizeCategories([null, 1, "x", ok])).toEqual([ok]);
  });

  it("ограничивает длину списка", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      key: `k${i}`, label: `L${i}`, icon: "🛍️", count: 1,
    }));
    expect(sanitizeCategories(many).length).toBeLessThanOrEqual(24);
  });
});
