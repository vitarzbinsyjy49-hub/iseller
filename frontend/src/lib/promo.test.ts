import { describe, expect, it } from "vitest";
import {
  cappedDiscount,
  forgetCode,
  loadSavedCode,
  normalizeCode,
  saveCode,
  totalWithDiscount,
  validateCode,
} from "./promo";

describe("normalizeCode", () => {
  it("приводит к верхнему регистру и обрезает пробелы", () => {
    expect(normalizeCode("  start20 ")).toBe("START20");
  });

  it("пустое остаётся пустым", () => {
    expect(normalizeCode("   ")).toBe("");
  });
});

describe("validateCode", () => {
  it("принимает обычный код", () => {
    expect(validateCode("start20")).toBeNull();
    expect(validateCode("NEW-YEAR_25")).toBeNull();
  });

  it("отвергает пустое", () => {
    expect(validateCode(" ")).toBeTruthy();
  });

  it("отвергает кириллицу и пробелы внутри", () => {
    expect(validateCode("скидка")).toBeTruthy();
    expect(validateCode("START 20")).toBeTruthy();
  });

  it("отвергает слишком длинный", () => {
    expect(validateCode("A".repeat(33))).toBeTruthy();
  });
});

describe("totalWithDiscount", () => {
  it("вычитает скидку", () => {
    expect(totalWithDiscount(100000, 5000)).toBe(95000);
  });

  it("ниже нуля не уходит", () => {
    expect(totalWithDiscount(3000, 5000)).toBe(0);
  });
});

describe("cappedDiscount", () => {
  it("скидка не больше корзины", () => {
    expect(cappedDiscount(3000, 5000)).toBe(3000);
  });

  it("обычный случай не трогает", () => {
    expect(cappedDiscount(100000, 5000)).toBe(5000);
  });

  it("отрицательного не бывает", () => {
    expect(cappedDiscount(0, 5000)).toBe(0);
  });
});

describe("хранение кода", () => {
  // Сам доступ к localStorage здесь не проверяем: в node его нет, а в проекте
  // тестируется чистая логика, не обёртки над хранилищем (см. searchHistory).
  // Проверяем единственное, что может сломаться молча — что отсутствие
  // хранилища не роняет корзину.
  it("без localStorage не падает и отдаёт пустое", () => {
    expect(() => saveCode("START20")).not.toThrow();
    expect(() => forgetCode()).not.toThrow();
    expect(loadSavedCode()).toBe("");
  });
});
