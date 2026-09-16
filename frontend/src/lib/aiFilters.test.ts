import { describe, expect, it } from "vitest";
import { catalogHref, filterChips } from "./aiFilters";

describe("filterChips", () => {
  it("показывает то, что модель поняла из фразы", () => {
    expect(filterChips({ brand: "Apple", budget_max: 120000, category: "смартфоны" }))
      .toEqual([
        { key: "category", label: "Смартфоны" },
        { key: "brand", label: "Apple" },
        // Неразрывный пробел внутри суммы, как в formatPrice.
        { key: "budget_max", label: "до 120 000 ₽" },
      ]);
  });

  it("состояние и наличие — словами", () => {
    expect(filterChips({ condition: "used", in_stock_only: true })).toEqual([
      { key: "in_stock_only", label: "В наличии" },
      { key: "condition", label: "Б/у" },
    ]);
  });

  it("ничего не поняли — чипов нет, а не пустые плашки", () => {
    expect(filterChips({})).toEqual([]);
    expect(filterChips(undefined)).toEqual([]);
    expect(filterChips({ budget_max: null, brand: null, category: null })).toEqual([]);
  });

  it("исключённый бренд НЕ показывается: каталог не умеет исключать", () => {
    // Чип обещает «нажми — увидишь это в каталоге». Фильтр, который каталог
    // молча не применит, это обещание нарушает.
    expect(filterChips({ excluded_brands: ["Samsung"] })).toEqual([]);
  });

  it("сценарии использования не фильтр каталога и в чипы не идут", () => {
    expect(filterChips({ use_cases: ["фото", "игры"] })).toEqual([]);
  });

  it("нулевой бюджет не чип: это не «до 0 ₽», а отсутствие бюджета", () => {
    expect(filterChips({ budget_max: 0 })).toEqual([]);
  });

  it("незнакомое состояние не выдумывается", () => {
    expect(filterChips({ condition: "странное" })).toEqual([]);
  });
});

describe("catalogHref", () => {
  it("собирает адрес каталога из понятого", () => {
    expect(catalogHref({ brand: "Apple", budget_max: 120000, category: "смартфоны" }))
      .toBe("/catalog?category=%D1%81%D0%BC%D0%B0%D1%80%D1%82%D1%84%D0%BE%D0%BD%D1%8B&brand=Apple&price_max=120000");
  });

  it("наличие и состояние уходят теми же именами, что читает каталог", () => {
    expect(catalogHref({ in_stock_only: true, condition: "used" }))
      .toBe("/catalog?in_stock=1&condition=used");
  });

  it("пустой разбор ведёт в обычный каталог, а не в каталог с мусором", () => {
    expect(catalogHref({})).toBe("/catalog");
    expect(catalogHref(undefined)).toBe("/catalog");
  });

  it("в адрес попадает ровно то, что показано чипами", () => {
    // Иначе кнопка открыла бы каталог с фильтром, которого человек не видел.
    const state = { brand: "Apple", excluded_brands: ["Samsung"], use_cases: ["фото"] };
    expect(catalogHref(state)).toBe("/catalog?brand=Apple");
    expect(filterChips(state).map((c) => c.key)).toEqual(["brand"]);
  });
});
