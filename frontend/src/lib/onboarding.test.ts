import { describe, expect, it } from "vitest";
import { advanceSlide, shouldShowOnboarding, tapZoneFor } from "./onboarding";

describe("shouldShowOnboarding", () => {
  it("нет пользователя — не показываем", () => {
    expect(shouldShowOnboarding(null)).toBe(false);
  });

  it("уже видел (не null) — не показываем", () => {
    expect(shouldShowOnboarding({ onboarding_seen_at: "2026-08-01T00:00:00Z" })).toBe(false);
  });

  it("новый и уже существующий пользователь с null — показываем одинаково", () => {
    expect(shouldShowOnboarding({ onboarding_seen_at: null })).toBe(true);
  });
});

describe("advanceSlide", () => {
  it("next посреди последовательности — просто следующий индекс", () => {
    expect(advanceSlide(1, 4, "next")).toBe(2);
  });

  it("next с последнего слайда — complete, а не несуществующий индекс", () => {
    expect(advanceSlide(3, 4, "next")).toBe("complete");
  });

  it("prev с первого слайда — не-оп", () => {
    expect(advanceSlide(0, 4, "prev")).toBe(0);
  });

  it("prev посреди последовательности — предыдущий индекс", () => {
    expect(advanceSlide(2, 4, "prev")).toBe(1);
  });
});

describe("tapZoneFor", () => {
  it("граница ровно на 1/3 относится к next", () => {
    expect(tapZoneFor(1 / 3)).toBe("next");
  });

  it("чуть левее границы — prev", () => {
    expect(tapZoneFor(1 / 3 - 0.001)).toBe("prev");
  });

  it("правый край — next", () => {
    expect(tapZoneFor(0.99)).toBe("next");
  });

  it("левый край — prev", () => {
    expect(tapZoneFor(0)).toBe("prev");
  });
});
