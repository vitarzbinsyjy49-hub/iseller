import { describe, expect, it } from "vitest";

import { navTiles } from "./navTiles";

const homeCat = {
  id: 1, title: "Смартфоны", emoji: "📱",
  action_type: "category", action_value: "смартфоны",
};
const homeBrand = {
  id: -1001, title: "Dyson", emoji: "🌀",
  action_type: "brand", action_value: "Dyson",
};
const cached = [{ key: "ноутбуки", label: "Ноутбуки", icon: "💻", count: 50 }];

describe("navTiles", () => {
  it("ось категорий берёт плитки из ответа /home", () => {
    const tiles = navTiles("category", { categories: [homeCat], brands: [homeBrand] }, []);
    expect(tiles).toEqual([
      {
        key: "1", label: "Смартфоны", icon: "📱",
        route: "/catalog?category=%D1%81%D0%BC%D0%B0%D1%80%D1%82%D1%84%D0%BE%D0%BD%D1%8B",
      },
    ]);
  });

  it("ось брендов берёт плитки бренда и ведёт в фильтр по бренду", () => {
    const tiles = navTiles("brand", { categories: [homeCat], brands: [homeBrand] }, []);
    expect(tiles).toEqual([
      { key: "-1001", label: "Dyson", icon: "🌀", route: "/catalog?brand=Dyson" },
    ]);
  });

  it("ось брендов пуста, если брендов нет — по этому компонент прячет тумблер", () => {
    expect(navTiles("brand", { categories: [homeCat], brands: [] }, cached)).toEqual([]);
  });

  it("бэкенд без ключа brands не роняет ось брендов", () => {
    expect(navTiles("brand", { categories: [homeCat] }, cached)).toEqual([]);
  });

  it("до ответа /home ось категорий рисуется из кэша", () => {
    const tiles = navTiles("category", null, cached);
    expect(tiles).toEqual([
      {
        key: "ноутбуки", label: "Ноутбуки", icon: "💻",
        route: "/catalog?category=%D0%BD%D0%BE%D1%83%D1%82%D0%B1%D1%83%D0%BA%D0%B8",
      },
    ]);
  });

  it("кэш не подменяет ось брендов: у брендов кэша нет", () => {
    expect(navTiles("brand", null, cached)).toEqual([]);
  });

  it("плитка без эмодзи получает нейтральную иконку", () => {
    const tiles = navTiles("category", { categories: [{ ...homeCat, emoji: null }], brands: [] }, []);
    expect(tiles[0].icon).toBe("🛍️");
  });
});
