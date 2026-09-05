import { describe, expect, it } from "vitest";
import {
  APP_SECTIONS,
  MIN_SECTION_QUERY_LEN,
  normalizeQuery,
  searchAppSections,
  toRuLayout,
} from "./appSections";

describe("normalizeQuery", () => {
  it("снимает регистр, схлопывает пробелы и приводит ё к е", () => {
    expect(normalizeQuery("  Ещё   ОДИН  ")).toBe("еще один");
  });
});

describe("toRuLayout", () => {
  it("переводит латиницу в то, что напечаталось бы в русской раскладке", () => {
    expect(toRuLayout("pfzdrb")).toBe("заявки");
  });

  it("оставляет как есть символы, которых нет в таблице", () => {
    expect(toRuLayout("айфон 15")).toBe("айфон 15");
  });
});

describe("searchAppSections", () => {
  it("находит раздел по его названию", () => {
    expect(searchAppSections("заявки").map((s) => s.key)).toContain("requests");
  });

  it("находит раздел по синониму, которого нет в названии", () => {
    expect(searchAppSections("бонусы").map((s) => s.key)).toContain("loyalty");
  });

  it("не требует переключать раскладку", () => {
    expect(searchAppSections("pfzdrb").map((s) => s.key)).toContain("requests");
  });

  it("ищет по началу слова, а не по любому вхождению", () => {
    expect(searchAppSections("ката").map((s) => s.key)).toContain("catalog");
    // «лог» — середина слова «каталог»: такие попадания превращают выдачу в шум
    expect(searchAppSections("лог").map((s) => s.key)).not.toContain("catalog");
  });

  it("находит по второму слову составного синонима", () => {
    // «статус заказа» → запрос «заказа»
    expect(searchAppSections("заказа").map((s) => s.key)).toContain("requests");
  });

  it("слишком короткий запрос не даёт разделов: одна буква — это шум над товарами", () => {
    expect(searchAppSections("к")).toEqual([]);
    expect(MIN_SECTION_QUERY_LEN).toBe(2);
  });

  it("пустой запрос не даёт разделов", () => {
    expect(searchAppSections("")).toEqual([]);
    expect(searchAppSections("   ")).toEqual([]);
  });

  it("запрос без совпадений даёт пустой список, а не весь реестр", () => {
    expect(searchAppSections("макбук про")).toEqual([]);
  });

  it("уважает предел выдачи", () => {
    // «о» — префикс многих синонимов; предел не даёт выдаче разрастись
    expect(searchAppSections("оп", 2).length).toBeLessThanOrEqual(2);
  });
});

describe("реестр разделов", () => {
  it("ключи уникальны", () => {
    const keys = APP_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("все маршруты внутренние и начинаются со слэша", () => {
    for (const s of APP_SECTIONS) expect(s.route.startsWith("/")).toBe(true);
  });

  it("синонимы записаны в нижнем регистре — иначе сравнение их не найдёт", () => {
    for (const s of APP_SECTIONS) {
      for (const syn of s.synonyms) expect(syn).toBe(syn.toLowerCase());
    }
  });
});
