import { describe, expect, it } from "vitest";
import { formatFxChip } from "./fxFormat";

describe("formatFxChip", () => {
  it("null при usdRate === null — чипу нечего рисовать", () => {
    expect(formatFxChip(null)).toBeNull();
  });

  it("значение — один знак после запятой, дельта — модуль", () => {
    const result = formatFxChip({ value: 91.23, delta: 0.34 });
    expect(result?.value).toBe("91,2");
    expect(result?.delta).toBe("0,3");
  });

  it("растущий курс — rising: true", () => {
    expect(formatFxChip({ value: 91.23, delta: 0.34 })?.rising).toBe(true);
  });

  it("падающий курс — rising: false, дельта всё равно положительная строка", () => {
    const result = formatFxChip({ value: 91.23, delta: -0.5 });
    expect(result?.rising).toBe(false);
    expect(result?.delta).toBe("0,5");
  });

  it("нулевая дельта — rising: true (не «падает»)", () => {
    expect(formatFxChip({ value: 91.23, delta: 0 })?.rising).toBe(true);
  });

  it("дельта, округляющаяся до 0,0 — delta: null (стрелке нечего показывать)", () => {
    // Гарантированный случай: день запуска (одна строка истории — дельта
    // ровно 0) и понедельник после выходных (ЦБ не публикует курс по
    // субботам/воскресеньям).
    const result = formatFxChip({ value: 91.23, delta: 0.04 });
    expect(result?.delta).toBeNull();
    expect(result?.value).toBe("91,2");
  });

  it("дельта чуть выше порога округления — delta не null", () => {
    expect(formatFxChip({ value: 91.23, delta: 0.05 })?.delta).toBe("0,1");
  });
});
