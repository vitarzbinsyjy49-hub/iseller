import { describe, expect, it } from "vitest";
import { cashbackFor, formatPoints, formatRate, pointsWord, progressPercent, nextPurchaseLine } from "./loyalty";

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

describe("cashbackFor с потолком", () => {
  it("срезает начисление так же, как сервер", () => {
    expect(cashbackFor(100_000, 100, 1500)).toBe(1000);
    expect(cashbackFor(300_000, 100, 1500)).toBe(1500);
    expect(cashbackFor(100_000, 300, 1500)).toBe(1500);
  });

  it("без потолка считает как раньше — старые вызовы не ломаются", () => {
    expect(cashbackFor(100_000, 300)).toBe(3000);
  });
});

describe("nextPurchaseLine", () => {
  // toLocaleString ставит НЕразрывный пробел — типографски верно, но в
  // сравнении со строкой из обычных пробелов даёт ложный провал.
  const plain = (s: string) => s.replace(/ /g, " ");

  it("называет и ставку, и потолок: ставка без потолка — полуправда", () => {
    const line = nextPurchaseLine({
      rate_bps: 100, rate_percent: 1, cap_points: 1500, promo: null, promo_until: null,
    });
    expect(line).toContain("1%");
    expect(plain(line)).toContain("1 500");
  });

  it("акцию называет акцией и ставит срок", () => {
    const line = nextPurchaseLine({
      rate_bps: 300, rate_percent: 3, cap_points: 1500,
      promo: "акция первой покупки", promo_until: "2026-11-01",
    });
    expect(line).toContain("3%");
    expect(plain(line)).toContain("1 500");
    expect(line).toContain("1 ноября");
  });

  it("срок без акции не показывается", () => {
    const line = nextPurchaseLine({
      rate_bps: 100, rate_percent: 1, cap_points: 1500, promo: null, promo_until: "2026-11-01",
    });
    expect(line).not.toContain("ноября");
  });
});
