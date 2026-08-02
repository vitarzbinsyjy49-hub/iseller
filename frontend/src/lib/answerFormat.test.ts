import { describe, expect, it } from "vitest";
import { parseAnswer, parseSpans, plainText } from "./answerFormat";

describe("parseSpans", () => {
  it("выделяет жирным то, что модель обернула в звёздочки", () => {
    expect(parseSpans("Берите **512 ГБ** с запасом")).toEqual([
      { text: "Берите ", bold: false },
      { text: "512 ГБ", bold: true },
      { text: " с запасом", bold: false },
    ]);
  });

  it("непарные звёздочки оставляет текстом, а не съедает строку", () => {
    expect(parseSpans("2**2 это четыре")).toEqual([{ text: "2**2 это четыре", bold: false }]);
  });

  it("держит несколько выделений в строке", () => {
    const spans = parseSpans("**256 ГБ** против **1 ТБ**");
    expect(spans.filter((s) => s.bold).map((s) => s.text)).toEqual(["256 ГБ", "1 ТБ"]);
  });
});

describe("parseAnswer", () => {
  it("разбивает по пустой строке на абзацы", () => {
    const blocks = parseAnswer("Первая мысль.\n\nВторая мысль.");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === "para")).toBe(true);
  });

  it("собирает подряд идущие пункты в один список", () => {
    const blocks = parseAnswer("Варианты:\n- 256 ГБ\n- 512 ГБ\n- 1 ТБ");
    expect(blocks[0].kind).toBe("para");
    expect(blocks[1]).toMatchObject({ kind: "list" });
    expect(blocks[1].kind === "list" && blocks[1].items).toHaveLength(3);
  });

  it("понимает не только дефис, но и тире с точкой", () => {
    const blocks = parseAnswer("— первый\n• второй");
    expect(blocks[0].kind === "list" && blocks[0].items).toHaveLength(2);
  });

  it("не склеивает соседние строки: каждая — своя мысль", () => {
    // Модель разделяет сравнения одиночным переносом. Склейка по правилам
    // markdown давала сплошную простыню — ровно то, что чиним.
    const blocks = parseAnswer("Pro Max против Pro\nPro Max против Air");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind === "para" && blocks[0].spans[0].text).toBe("Pro Max против Pro");
    expect(blocks[1].kind === "para" && blocks[1].spans[0].text).toBe("Pro Max против Air");
  });

  it("пустой ответ не даёт пустых блоков", () => {
    expect(parseAnswer("")).toEqual([]);
    expect(parseAnswer("   \n\n  ")).toEqual([]);
  });

  it("одна фраза остаётся одним абзацем, без списка из одного пункта", () => {
    const blocks = parseAnswer("Да, этот подойдёт.");
    expect(blocks).toEqual([{ kind: "para", spans: [{ text: "Да, этот подойдёт.", bold: false }] }]);
  });
});

describe("plainText", () => {
  it("возвращает текст без разметки — им меряется анимация набора", () => {
    const text = plainText(parseAnswer("Итог: **512 ГБ**\n\n- дешевле\n- надёжнее"));
    expect(text).not.toContain("*");
    expect(text).not.toContain("- ");
    expect(text).toContain("512 ГБ");
    expect(text).toContain("дешевле");
  });
});
