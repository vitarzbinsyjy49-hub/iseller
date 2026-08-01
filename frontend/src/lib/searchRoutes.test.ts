import { describe, expect, it } from "vitest";
import { aiSearchRoute, catalogSearchRoute } from "./searchRoutes";

describe("catalogSearchRoute", () => {
  it("ведёт в каталог с запросом", () => {
    expect(catalogSearchRoute("iphone")).toBe("/catalog?query=iphone");
  });

  it("пустой запрос открывает каталог целиком", () => {
    expect(catalogSearchRoute("   ")).toBe("/catalog");
    expect(catalogSearchRoute("")).toBe("/catalog");
  });

  it("экранирует спецсимволы", () => {
    expect(catalogSearchRoute("фен & стайлер")).toBe(
      "/catalog?query=%D1%84%D0%B5%D0%BD%20%26%20%D1%81%D1%82%D0%B0%D0%B9%D0%BB%D0%B5%D1%80",
    );
  });
});

describe("aiSearchRoute", () => {
  it("с текстом сразу отправляет запрос", () => {
    // auto=1: нажатие кнопки с набранным текстом — уже явное «спроси про это».
    expect(aiSearchRoute("что подарить маме")).toContain("&auto=1");
    expect(aiSearchRoute("iphone")).toBe("/ai?q=iphone&auto=1");
  });

  it("без текста просто открывает экран AI, ничего не отправляя", () => {
    expect(aiSearchRoute("")).toBe("/ai");
    expect(aiSearchRoute("   ")).toBe("/ai");
  });

  it("обрезает пробелы и экранирует", () => {
    expect(aiSearchRoute("  фен  ")).toBe("/ai?q=%D1%84%D0%B5%D0%BD&auto=1");
  });
});
