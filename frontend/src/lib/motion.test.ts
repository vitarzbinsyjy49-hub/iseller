import { describe, expect, it } from "vitest";
import {
  FADE_MS,
  animateNumber,
  easeOutQuint,
  scrollPositionAt,
  transitionDuration,
  transitionStyle,
} from "./motion";

describe("transitionStyle", () => {
  it("обычный режим — движение", () => {
    expect(transitionStyle(false)).toBe("move");
  });

  it("«уменьшить движение» — затухание вместо движения", () => {
    expect(transitionStyle(true)).toBe("fade");
  });

  it("варианта «ничего» не существует ни в одном режиме", () => {
    // Ради этого модуль и заведён: раньше четыре места из шести отвечали
    // «тогда не делаем ничего», и интерфейс терял не анимацию, а событие —
    // человек переставал понимать, что произошло.
    for (const reduced of [true, false]) {
      expect(["move", "fade"]).toContain(transitionStyle(reduced));
    }
  });
});

describe("transitionDuration", () => {
  it("обычный режим — заданная длительность движения", () => {
    expect(transitionDuration(190, false)).toBe(190);
  });

  it("«уменьшить движение» — время затухания, а не ноль", () => {
    expect(transitionDuration(190, true)).toBe(FADE_MS);
    expect(transitionDuration(190, true)).toBeGreaterThan(0);
  });

  it("нулевой длительности не отдаёт даже при нулевом движении", () => {
    expect(transitionDuration(0, true)).toBe(FADE_MS);
  });
});

describe("easeOutQuint", () => {
  it("начинается в нуле и заканчивается в единице", () => {
    expect(easeOutQuint(0)).toBe(0);
    expect(easeOutQuint(1)).toBe(1);
  });

  it("тормозит к концу: за первую половину времени проходит больше половины пути", () => {
    expect(easeOutQuint(0.5)).toBeGreaterThan(0.5);
  });

  it("выход за границы времени зажимается, а не улетает", () => {
    expect(easeOutQuint(-1)).toBe(0);
    expect(easeOutQuint(5)).toBe(1);
  });
});

describe("animateNumber", () => {
  it("не прыгает сразу в конец, даже если браузер задержал первый rAF-кадр", () => {
    // На живом устройстве браузер иногда не отдаёт requestAnimationFrame сотни
    // миллисекунд (сеть + ре-рендер сразу после submit — типичный момент).
    // Раньше start фиксировался в момент ВЫЗОВА: первый дошедший кадр уже видел
    // elapsed > duration и сразу применял `to`, без единого промежуточного
    // значения — так и выглядела «анимация есть в коде, а на экране её нет».
    let pending: FrameRequestCallback | null = null;
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { pending = cb; return 1; }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

    try {
      const calls: number[] = [];
      animateNumber(0, 100, 400, (v) => calls.push(v));
      // Первый тик приходит с огромной задержкой относительно вызова — но start
      // анкерится на ЭТОТ момент, а не на момент вызова.
      pending!(999_999);
      expect(calls[0]).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    }
  });
});

describe("scrollPositionAt", () => {
  it("в начале — исходная позиция, в конце — целевая", () => {
    expect(scrollPositionAt(0, 320, 0, 400)).toBe(0);
    expect(scrollPositionAt(0, 320, 400, 400)).toBe(320);
  });

  it("после конца анимации не проскакивает мимо цели", () => {
    expect(scrollPositionAt(0, 320, 999, 400)).toBe(320);
  });

  it("едет и назад тоже", () => {
    const mid = scrollPositionAt(320, 0, 200, 400);
    expect(mid).toBeLessThan(320);
    expect(mid).toBeGreaterThan(0);
  });

  it("нулевая длительность — сразу цель, без деления на ноль", () => {
    expect(scrollPositionAt(0, 320, 0, 0)).toBe(320);
  });
});
