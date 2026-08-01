import { describe, expect, it } from "vitest";
import { specChips } from "./specChips";

describe("specChips", () => {
  it("схлопывает одинаковые память и накопитель в один чип", () => {
    // Ровно случай с прода: memory и storage повторяют друг друга.
    expect(specChips(["Midnight", "512 ГБ", "512 ГБ"])).toEqual(["Midnight", "512 ГБ"]);
  });

  it("оставляет оба, когда значения правда разные", () => {
    expect(specChips([null, "8 ГБ", "256 ГБ"])).toEqual(["8 ГБ", "256 ГБ"]);
  });

  it("не различает по регистру", () => {
    expect(specChips(["512 гб", "512 ГБ"])).toEqual(["512 гб"]);
  });

  it("схлопывает двойные пробелы из выгрузки", () => {
    expect(specChips(["2  ТБ"])).toEqual(["2 ТБ"]);
    expect(specChips(["2  ТБ", "2 ТБ"])).toEqual(["2 ТБ"]);
  });

  it("выбрасывает пустое, null и пробельное", () => {
    expect(specChips([null, undefined, "", "   ", "Синий"])).toEqual(["Синий"]);
  });

  it("сохраняет порядок полей: цвет, потом объёмы", () => {
    expect(specChips(["Titanium", "1 ТБ"])).toEqual(["Titanium", "1 ТБ"]);
  });
});
