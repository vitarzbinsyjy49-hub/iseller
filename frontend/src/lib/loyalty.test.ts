import { describe, expect, it } from "vitest";
import { cashbackFor, formatPoints, formatRate, pointsWord, progressPercent } from "./loyalty";

describe("formatRate", () => {
  it("пишет ставку по-русски, через запятую", () => {
    expect(formatRate(25)).toBe("0,25%");
    expect(formatRate(50)).toBe("0,5%");
    expect(formatRate(100)).toBe("1%");
    expect(formatRate(200)).toBe("2%");
  });
});

describe("progressPercent", () => {
  it("не рисует прогресс тому, кто ещё не покупал", () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(-1)).toBe(0);
    expect(progressPercent(NaN)).toBe(0);
  });

  it("даёт видимый минимум при крошечном, но реальном прогрессе", () => {
    // Полоска в один пиксель читается как «ничего не засчитано».
    expect(progressPercent(0.001)).toBe(4);
  });

  it("не превышает ста процентов", () => {
    expect(progressPercent(1)).toBe(100);
    expect(progressPercent(5)).toBe(100);
    expect(progressPercent(0.5)).toBe(50);
  });
});

describe("pointsWord", () => {
  it("склоняет по русским правилам", () => {
    expect(pointsWord(1)).toBe("балл");
    expect(pointsWord(2)).toBe("балла");
    expect(pointsWord(5)).toBe("баллов");
    expect(pointsWord(11)).toBe("баллов");   // не «балл»
    expect(pointsWord(14)).toBe("баллов");
    expect(pointsWord(21)).toBe("балл");
    expect(pointsWord(102)).toBe("балла");
    expect(pointsWord(250)).toBe("баллов");
    expect(pointsWord(0)).toBe("баллов");
  });

  it("не зависит от знака: списание тоже склоняется", () => {
    expect(pointsWord(-1)).toBe("балл");
    expect(formatPoints(-1000)).toContain("баллов");
  });
});

describe("cashbackFor", () => {
  it("считает так же, как сервер, и округляет вниз", () => {
    expect(cashbackFor(100_000, 25)).toBe(250);
    expect(cashbackFor(99_999, 25)).toBe(249);
    expect(cashbackFor(100_000, 200)).toBe(2000);
  });

  it("на нулевых входах молчит, а не выдаёт NaN", () => {
    expect(cashbackFor(0, 25)).toBe(0);
    expect(cashbackFor(100_000, 0)).toBe(0);
  });
});
