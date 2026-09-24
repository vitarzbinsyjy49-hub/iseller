import { describe, expect, it } from "vitest";
import { colorHex, isExact, otherVersions, pickVariant, valueLabel, type Variants } from "./variants";

const o = (id: number, storage: string, color: string, sim: string, price: number,
  in_stock = true, regions: string[] = []) =>
  ({ id, values: { "Цвет": color, "Память": storage, SIM: sim }, price, in_stock, regions });

const v: Variants = {
  axes: [
    { name: "Цвет", values: ["Black", "Burgundy"] },
    { name: "Память", values: ["256 ГБ", "512 ГБ"] },
    { name: "SIM", values: ["SIM+eSIM", "eSIM"] },
  ],
  current: { values: { "Цвет": "Black", "Память": "256 ГБ", SIM: "SIM+eSIM" }, regions: ["KR", "HK"] },
  options: [
    o(1, "256 ГБ", "Black", "SIM+eSIM", 129000, true, ["KR", "HK"]),
    o(2, "256 ГБ", "Black", "SIM+eSIM", 128000, true, ["HK"]),
    o(3, "256 ГБ", "Black", "eSIM", 127500),
    o(4, "256 ГБ", "Burgundy", "SIM+eSIM", 137500),
    o(5, "256 ГБ", "Burgundy", "eSIM", 130500),
    o(6, "512 ГБ", "Black", "SIM+eSIM", 155000),
    o(7, "512 ГБ", "Burgundy", "eSIM", 161000),
    o(8, "512 ГБ", "Black", "SIM+eSIM", 150000, false),
  ],
};

const burgundy: Variants = {
  ...v, current: { ...v.current, values: { ...v.current.values, "Цвет": "Burgundy" } },
};

describe("pickVariant", () => {
  it("меняет одну ось, остальные сохраняет, и берёт самый дешёвый", () => {
    expect(pickVariant(v, "Цвет", "Burgundy")?.id).toBe(4);
    expect(pickVariant(v, "SIM", "eSIM")?.id).toBe(3);
  });

  it("отсутствующий в наличии не выигрывает, даже если дешевле", () => {
    expect(pickVariant(v, "Память", "512 ГБ")?.id).toBe(6);
  });

  it("нет точной комбинации — цвет важнее SIM", () => {
    // Burgundy 512 есть только eSIM: память меняется, SIM уступает, цвет — нет.
    expect(pickVariant(burgundy, "Память", "512 ГБ")?.id).toBe(7);
  });

  it("неизвестное значение — null", () => {
    expect(pickVariant(v, "Цвет", "Pink")).toBeNull();
  });

  it("оси любой линейки, а не только iPhone", () => {
    const mac: Variants = {
      axes: [{ name: "Конфигурация", values: ["16 ГБ · 256 ГБ", "24 ГБ · 512 ГБ"] }],
      current: { values: { "Конфигурация": "16 ГБ · 256 ГБ" }, regions: [] },
      options: [
        { id: 10, values: { "Конфигурация": "16 ГБ · 256 ГБ" }, regions: [], price: 60000, in_stock: true },
        { id: 11, values: { "Конфигурация": "24 ГБ · 512 ГБ" }, regions: [], price: 90000, in_stock: true },
      ],
    };
    expect(pickVariant(mac, "Конфигурация", "24 ГБ · 512 ГБ")?.id).toBe(11);
  });
});

describe("isExact / otherVersions / colorHex / valueLabel", () => {
  it("помечает сочетания, которых нет", () => {
    expect(isExact(burgundy, "Память", "512 ГБ")).toBe(false);
    expect(isExact(v, "Память", "512 ГБ")).toBe(true);
  });

  it("другие версии — те же оси, другой регион, дешёвые первыми", () => {
    expect(otherVersions(v, 1).map((x) => x.id)).toEqual([2]);
  });

  it("цвет по имени, по слову, а незнакомый не пропадает", () => {
    expect(colorHex("Glacier")).toBe("#b9ceda");
    expect(colorHex("Ceramic Pink")).toBe("#f1c9cf");
    expect(colorHex("Cosmic Teal")).toBe("#3f8a8c");
    expect(colorHex("Zzz")).toBe("#c7c7cc");
  });

  it("SIM подписана словами", () => {
    expect(valueLabel("SIM", "eSIM")).toBe("Только eSIM");
    expect(valueLabel("Память", "256 ГБ")).toBe("256 ГБ");
  });
});
