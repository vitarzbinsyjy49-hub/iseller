import { describe, expect, it } from "vitest";
import { advanceSlide, shouldShowOnboarding, tapZoneFor, releaseDirection, dragOffset, isTap } from "./onboarding";

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

describe("releaseDirection — куда докатить экран, когда палец отпущен", () => {
  const W = 400;
  it("короткий медленный сдвиг — остаёмся на месте", () => {
    expect(releaseDirection(-60, W, 0.1)).toBe("stay");
    expect(releaseDirection(60, W, -0.1)).toBe("stay");
  });
  it("больше четверти экрана — листаем в сторону жеста", () => {
    expect(releaseDirection(-120, W, 0)).toBe("next");
    expect(releaseDirection(120, W, 0)).toBe("prev");
  });
  it("короткий, но быстрый смахивающий жест — тоже листает", () => {
    expect(releaseDirection(-40, W, -0.8)).toBe("next");
    expect(releaseDirection(40, W, 0.8)).toBe("prev");
  });
  it("быстрый рывок против сдвига не листает назад через ноль", () => {
    // Потянул влево на полэкрана и дёрнул обратно: это отмена, а не «назад».
    expect(releaseDirection(-200, W, 0.9)).toBe("stay");
  });
});

describe("dragOffset — экран за пальцем", () => {
  it("посреди последовательности идёт за пальцем один к одному", () => {
    expect(dragOffset(-80, 2, 5)).toBe(-80);
    expect(dragOffset(80, 2, 5)).toBe(80);
  });
  it("влево с первого экрана тянется туго — дальше некуда", () => {
    expect(dragOffset(90, 0, 5)).toBe(30);
  });
  it("вправо с последнего идёт свободно: это закрытие онбординга", () => {
    expect(dragOffset(-90, 4, 5)).toBe(-90);
  });
});

describe("isTap", () => {
  it("почти без движения и быстро — тап", () => {
    expect(isTap(4, 180)).toBe(true);
  });
  it("сдвиг пальца — не тап", () => {
    expect(isTap(14, 120)).toBe(false);
  });
  it("долгое удержание — пауза, а не тап", () => {
    expect(isTap(2, 600)).toBe(false);
  });
});
