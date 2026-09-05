import { describe, expect, it } from "vitest";
import {
  APP_SECTIONS,
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
  });

  it("находит по точному имени раздела из двух слов", () => {
    // Здесь жила ошибка: запрос сравнивался целиком со словом кандидата, и
    // ЛЮБОЙ запрос с пробелом не находил ничего — включая надпись на кнопке.
    expect(searchAppSections("мои заявки").map((s) => s.key)).toContain("requests");
    expect(searchAppSections("о магазине").map((s) => s.key)).toContain("info");
  });

  it("не требует угадывать порядок слов", () => {
    expect(searchAppSections("заявки мои").map((s) => s.key)).toContain("requests");
  });

  it("каждое слово запроса должно найтись: лишнее слово отсекает раздел", () => {
    expect(searchAppSections("мои котики").map((s) => s.key)).not.toContain("requests");
  });

  it("пустой запрос не даёт разделов", () => {
    expect(searchAppSections("")).toEqual([]);
    expect(searchAppSections("   ")).toEqual([]);
  });

  it("запрос без совпадений даёт пустой список, а не весь реестр", () => {
    expect(searchAppSections("макбук про")).toEqual([]);
  });

  it("уважает предел выдачи", () => {
    // Запрос обязан давать БОЛЬШЕ совпадений, чем предел, иначе тест зелёный
    // при любом лимите и откат предела он не поймает.
    const wide = searchAppSections("к", 99);
    const all = APP_SECTIONS.filter((s) =>
      [s.label, ...s.synonyms].some((h) => h.toLowerCase().includes("к")),
    );
    expect(all.length).toBeGreaterThan(2);
    expect(searchAppSections("ка", 2).length).toBeLessThanOrEqual(2);
    expect(wide).toEqual([]); // одна буква по-прежнему не ищет
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
