import { describe, expect, it } from "vitest";
import { bundleItems } from "./bundle";

describe("bundleItems", () => {
  it("разбирает перечисление из админки", () => {
    expect(bundleItems({ "В комплекте": "PS5 Pro 2 ТБ, DualSense, GTA VI" }))
      .toEqual(["PS5 Pro 2 ТБ", "DualSense", "GTA VI"]);
  });

  it("терпит лишние пробелы и хвостовую запятую", () => {
    expect(bundleItems({ "В комплекте": " Консоль ,  Геймпад ,, " }))
      .toEqual(["Консоль", "Геймпад"]);
  });

  it("одна позиция — это не комплект, секции быть не должно", () => {
    // Строка «PlayStation 5 Pro» перечислением не является: блок «что внутри»
    // с единственной строкой повторяет заголовок страницы и ничего не добавляет.
    expect(bundleItems({ "В комплекте": "PlayStation 5 Pro" })).toEqual([]);
  });

  it("нет ключа или пустые характеристики — пустой список, а не падение", () => {
    expect(bundleItems({ Гарантия: "14 дней" })).toEqual([]);
    expect(bundleItems(undefined)).toEqual([]);
  });

  it("ключ ищется без учёта регистра и лишних пробелов", () => {
    expect(bundleItems({ "  в КОМПЛЕКТЕ ": "Консоль, Игра" })).toEqual(["Консоль", "Игра"]);
  });
});
