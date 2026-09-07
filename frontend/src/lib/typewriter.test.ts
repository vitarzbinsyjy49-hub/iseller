import { describe, expect, it } from "vitest";

import {
  TYPEWRITER_TIMING,
  cycleMs,
  packPhrases,
  phraseCycleMs,
  typewriterTextAt,
  unpackPhrases,
} from "./typewriter";

const T = { typeMs: 100, deleteMs: 50, holdMs: 1000, gapMs: 200 };

describe("packPhrases / unpackPhrases", () => {
  it("многословная фраза переживает круг склейки целиком", () => {
    // Ровно на этом сломалось в первой версии: разделителем был ПРОБЕЛ, и
    // «мои заявки» превращались в две фразы. Список молча подменялся другим,
    // а на глаз дефект не читался, пока первая фраза была односложной.
    const фразы = ["смартфоны", "мои заявки", "найти технику дешевле"];
    expect(unpackPhrases(packPhrases(фразы))).toEqual(фразы);
  });

  it("пустая строка даёт пустой список, а не список из пустой фразы", () => {
    expect(unpackPhrases("")).toEqual([]);
    expect(unpackPhrases(packPhrases([]))).toEqual([]);
  });

  it("одна фраза остаётся одной", () => {
    expect(unpackPhrases(packPhrases(["избранное"]))).toEqual(["избранное"]);
  });
});

describe("typewriterTextAt", () => {
  it("набирает фразу по символу и показывает первый сразу", () => {
    // Пустого кадра в начале нет: строка, которая секунду выглядит пустой,
    // читается как сломанная, а не как «сейчас начнёт печатать».
    expect(typewriterTextAt(["дом"], 0, T)).toBe("д");
    expect(typewriterTextAt(["дом"], 100, T)).toBe("до");
    expect(typewriterTextAt(["дом"], 200, T)).toBe("дом");
  });

  it("держит целую фразу всю паузу", () => {
    const typed = 3 * T.typeMs;
    expect(typewriterTextAt(["дом"], typed, T)).toBe("дом");
    expect(typewriterTextAt(["дом"], typed + T.holdMs - 1, T)).toBe("дом");
  });

  it("стирает фразу до пустой строки", () => {
    const afterHold = 3 * T.typeMs + T.holdMs;
    expect(typewriterTextAt(["дом"], afterHold, T)).toBe("до");
    expect(typewriterTextAt(["дом"], afterHold + T.deleteMs, T)).toBe("д");
    expect(typewriterTextAt(["дом"], afterHold + 2 * T.deleteMs, T)).toBe("");
  });

  it("держит пустую строку в паузе между фразами", () => {
    const afterDelete = 3 * T.typeMs + T.holdMs + 3 * T.deleteMs;
    expect(typewriterTextAt(["дом"], afterDelete, T)).toBe("");
    expect(typewriterTextAt(["дом"], afterDelete + T.gapMs - 1, T)).toBe("");
  });

  it("переходит к следующей фразе и зацикливается", () => {
    const first = phraseCycleMs("дом", T);
    expect(typewriterTextAt(["дом", "сад"], first, T)).toBe("с");
    // Полный круг возвращает в самое начало: анимация не имеет конца, и
    // «последняя фраза навсегда» выглядела бы как зависание.
    expect(typewriterTextAt(["дом", "сад"], cycleMs(["дом", "сад"], T), T)).toBe("д");
  });

  it("переживает отрицательное и огромное время", () => {
    // rAF даёт монотонное время, но вызывающий может вычесть старт, взятый
    // из другого источника, — на этом легко получить отрицательный остаток.
    expect(typewriterTextAt(["дом"], -1, T)).toBe("");
    expect(typewriterTextAt(["дом"], 1e9, T)).not.toBe(undefined);
  });

  it("пустой список и пустые фразы не роняют расчёт", () => {
    expect(typewriterTextAt([], 500, T)).toBe("");
    expect(typewriterTextAt(["", ""], 500, T)).toBe("");
    expect(typewriterTextAt(["", "сад"], 0, T)).toBe("с");
  });

  it("боевые тайминги дают заметную, но не суетливую печать", () => {
    // Защита от случайной правки констант: полный круг одной короткой фразы
    // должен читаться человеком, а не мелькать.
    expect(phraseCycleMs("смартфоны", TYPEWRITER_TIMING)).toBeGreaterThan(2000);
    expect(phraseCycleMs("смартфоны", TYPEWRITER_TIMING)).toBeLessThan(5000);
  });
});
