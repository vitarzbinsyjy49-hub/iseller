import { describe, expect, it } from "vitest";

import { searchRoute } from "./searchMode";

describe("searchRoute", () => {
  it("режим каталога ведёт в каталог с запросом", () => {
    expect(searchRoute("catalog", "iphone")).toBe("/catalog?query=iphone");
  });

  it("режим AI ведёт в чат с предзаполненным запросом", () => {
    expect(searchRoute("ai", "iphone")).toBe("/ai?q=iphone");
  });

  it("пустой запрос открывает раздел без параметра", () => {
    expect(searchRoute("catalog", "   ")).toBe("/catalog");
    expect(searchRoute("ai", "")).toBe("/ai");
  });

  it("кириллица и служебные символы экранируются", () => {
    expect(searchRoute("catalog", "фен & стайлер")).toBe(
      "/catalog?query=%D1%84%D0%B5%D0%BD%20%26%20%D1%81%D1%82%D0%B0%D0%B9%D0%BB%D0%B5%D1%80",
    );
  });

  it("пробелы по краям не попадают в маршрут", () => {
    expect(searchRoute("ai", "  фен  ")).toBe("/ai?q=%D1%84%D0%B5%D0%BD");
  });
});
