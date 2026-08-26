import { describe, expect, it } from "vitest";
import { LAUNCH_AT, formatCountdown, isLaunched } from "./launch";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatCountdown", () => {
  it("после запуска отсчёта нет — полоса обязана исчезнуть сама", () => {
    expect(formatCountdown(0)).toBeNull();
    expect(formatCountdown(-1)).toBeNull();
  });

  it("склоняет дни: «1 день», «2 дня», «11 дней»", () => {
    expect(formatCountdown(DAY + MINUTE)?.text).toBe("1 день");
    expect(formatCountdown(2 * DAY)?.text).toBe("2 дня");
    expect(formatCountdown(11 * DAY)?.text).toBe("11 дней");
    expect(formatCountdown(21 * DAY)?.text).toBe("21 день");
  });

  it("часы и минуты — без секунд", () => {
    expect(formatCountdown(4 * HOUR + 12 * MINUTE + 30_000)?.text).toBe("4 ч 12 мин");
  });

  it("в последний час показывает секунды и тикает раз в секунду", () => {
    const left = formatCountdown(5 * MINUTE + 7_000);
    expect(left?.text).toBe("5:07");
    expect(left?.tickMs).toBe(1000);
  });

  it("до последнего часа тикает раз в минуту, а не раз в секунду", () => {
    // Посекундная перерисовка весь день — это разряженная батарея в Telegram
    // WebView ради цифры, которую никто не разглядывает.
    expect(formatCountdown(3 * HOUR)?.tickMs).toBe(60_000);
    expect(formatCountdown(3 * DAY)?.tickMs).toBe(60_000);
  });
});

describe("isLaunched", () => {
  it("переключается ровно в момент LAUNCH_AT", () => {
    expect(isLaunched(new Date(LAUNCH_AT.getTime() - 1))).toBe(false);
    expect(isLaunched(new Date(LAUNCH_AT.getTime()))).toBe(true);
  });

  it("момент запуска — 27 августа 2026, 15:15 по Москве", () => {
    expect(LAUNCH_AT.toISOString()).toBe("2026-08-27T12:15:00.000Z");
  });
});
