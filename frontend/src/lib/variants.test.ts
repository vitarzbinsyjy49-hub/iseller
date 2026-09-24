import { describe, expect, it } from "vitest";
import { colorHex, isExact, otherVersions, pickVariant, type Variants } from "./variants";

const o = (id: number, storage: string, color: string, sim: string, price: number,
  in_stock = true, regions: string[] = []) => ({ id, storage, color, sim, price, in_stock, regions });

const v: Variants = {
  axes: {
    storage: ["256 ГБ", "512 ГБ"],
    color: ["Black", "Burgundy"],
    sim: ["SIM+eSIM", "eSIM"],
  },
  current: { storage: "256 ГБ", color: "Black", sim: "SIM+eSIM", regions: ["KR", "HK"] },
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

describe("pickVariant", () => {
  it("меняет одну ось, остальные сохраняет, и берёт самый дешёвый", () => {
    expect(pickVariant(v, "color", "Burgundy")?.id).toBe(4);
    expect(pickVariant(v, "sim", "eSIM")?.id).toBe(3);
  });

  it("отсутствующий в наличии не выигрывает, даже если дешевле", () => {
    expect(pickVariant(v, "storage", "512 ГБ")?.id).toBe(6);
  });

  it("нет точной комбинации — ближайший по остальным осям", () => {
    const burgundy = { ...v, current: { ...v.current, color: "Burgundy" } };
    // Burgundy 512 есть только eSIM: память меняется, SIM уступает.
    expect(pickVariant(burgundy, "storage", "512 ГБ")?.id).toBe(7);
  });

  it("неизвестное значение — null", () => {
    expect(pickVariant(v, "color", "Pink")).toBeNull();
  });
});

describe("isExact / otherVersions / colorHex", () => {
  it("помечает сочетания, которых нет", () => {
    const burgundy = { ...v, current: { ...v.current, color: "Burgundy" } };
    expect(isExact(burgundy, "storage", "512 ГБ")).toBe(false);
    expect(isExact(v, "storage", "512 ГБ")).toBe(true);
  });

  it("другие версии — та же конфигурация, другой регион, дешёвые первыми", () => {
    expect(otherVersions(v, 1).map((x) => x.id)).toEqual([2]);
  });

  it("незнакомый цвет не пропадает", () => {
    expect(colorHex("Glacier")).toBe("#b9ceda");
    expect(colorHex("Cosmic Teal")).toBe("#c7c7cc");
  });
});
