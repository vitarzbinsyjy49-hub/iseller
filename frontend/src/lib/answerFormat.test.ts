import { describe, expect, it } from "vitest";
import { hasLead, parseAnswer, parseSpans, plainText } from "./answerFormat";

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

describe("hasLead", () => {
  it("короткая первая фраза, за которой есть текст — это вывод", () => {
    expect(hasLead(parseAnswer("Подходят три модели.\n\nРазница только в памяти и цвете."))).toBe(true);
  });

  it("единственный абзац выводом не делаем: крупным стал бы весь ответ", () => {
    expect(hasLead(parseAnswer("Подходят три модели."))).toBe(false);
  });

  it("длинная первая фраза остаётся обычным абзацем", () => {
    const long = "а".repeat(200);
    expect(hasLead(parseAnswer(`${long}\n\nВторой абзац.`))).toBe(false);
  });

  it("список первым блоком выводом не бывает", () => {
    expect(hasLead(parseAnswer("- первый пункт\n- второй пункт\n\nАбзац после."))).toBe(false);
  });

  it("пустой ответ не роняет проверку", () => {
    expect(hasLead(parseAnswer(""))).toBe(false);
  });
});

describe("пункт списка, приклеенный к концу абзаца", () => {
  it("отрывает пункт, который модель приписала к предыдущей фразе", () => {
    const blocks = parseAnswer("Разница в памяти. - 256 ГБ хватает\n- 512 ГБ для видео");
    expect(blocks).toEqual([
      { kind: "para", spans: [{ text: "Разница в памяти.", bold: false }] },
      { kind: "list", items: [
        [{ text: "256 ГБ хватает", bold: false }],
        [{ text: "512 ГБ для видео", bold: false }],
      ] },
    ]);
  });

  it("разбирает несколько пунктов, склеенных в одну строку", () => {
    const blocks = parseAnswer("Итого. - раз. - два");
    expect(blocks).toEqual([
      { kind: "para", spans: [{ text: "Итого.", bold: false }] },
      { kind: "list", items: [
        [{ text: "раз.", bold: false }],
        [{ text: "два", bold: false }],
      ] },
    ]);
  });

  it("длинное тире мид-фразы НЕ считается пунктом: это русская пунктуация", () => {
    const blocks = parseAnswer("Берите 512 ГБ. — так надёжнее");
    expect(blocks).toEqual([
      { kind: "para", spans: [{ text: "Берите 512 ГБ. — так надёжнее", bold: false }] },
    ]);
  });

  it("дефис без точки перед ним абзац не рвёт", () => {
    const blocks = parseAnswer("модель iPhone 17 - отличный выбор");
    expect(blocks).toEqual([
      { kind: "para", spans: [{ text: "модель iPhone 17 - отличный выбор", bold: false }] },
    ]);
  });
});
