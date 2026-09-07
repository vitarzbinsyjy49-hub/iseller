import { describe, expect, it } from "vitest";
import { formatPercent, termsLines } from "./referral";

describe("formatPercent", () => {
  it("пишет процент по-русски, с запятой", () => {
    expect(formatPercent(1)).toBe("1%");
    expect(formatPercent(1.5)).toBe("1,5%");
    expect(formatPercent(2.75)).toBe("2,75%");
  });

  it("ноль и мусор не превращаются в обещание", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(Number.NaN)).toBe("0%");
  });
});

describe("termsLines", () => {
  it("называет условия числами сервера, а не зашитыми в код", () => {
    const lines = termsLines({ rate_percent: 1, welcome_bonus_points: 1000 });
    // Пробел в «1 000» неразрывный — сравниваем по цифрам, а не по виду.
    expect(lines[0].replace(/\s/g, " ")).toContain("1 000");
    expect(lines[1]).toContain("1%");
    expect(lines[2]).toContain("забрал заказ");
  });

  it("выключенная часть программы не обещается", () => {
    // Владелец может обнулить бонус в админке — обещать его после этого нельзя.
    const lines = termsLines({ rate_percent: 1, welcome_bonus_points: 0 });
    expect(lines.some((l) => l.includes("Другу"))).toBe(false);

    const noRate = termsLines({ rate_percent: 0, welcome_bonus_points: 500 });
    expect(noRate.some((l) => l.includes("Вам"))).toBe(false);
  });
});
