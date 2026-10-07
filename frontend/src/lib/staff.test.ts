import { describe, expect, it } from "vitest";
import { isBigChange, parsePriceInput, sourceLabel } from "./staff";

describe("parsePriceInput", () => {
  it("понимает цену в любом привычном виде", () => {
    expect(parsePriceInput("132500")).toBe(132500);
    expect(parsePriceInput("132 500")).toBe(132500);
    expect(parsePriceInput("132.500")).toBe(132500);
    expect(parsePriceInput("132 500 ₽")).toBe(132500);
  });
  it("мусор и ноль — не цена", () => {
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput("abc")).toBeNull();
    expect(parsePriceInput("0")).toBeNull();
    expect(parsePriceInput("-500")).toBeNull();
  });
});

describe("isBigChange", () => {
  it("больше 30% — нужна вторая проверка, как на сервере", () => {
    expect(isBigChange(120000, 132500)).toBe(false);
    expect(isBigChange(120000, 12000)).toBe(true);
    expect(isBigChange(null, 5)).toBe(false);
  });
});

it("подписи источников по-русски", () => {
  expect(sourceLabel("staff")).toBe("вручную");
  expect(sourceLabel("bsa")).toBe("BSA");
});
