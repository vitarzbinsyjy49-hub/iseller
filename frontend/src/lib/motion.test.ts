import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FADE_MS,
  ONBOARDING_APPEAR_MS,
  SHEET_IN_MS,
  SHEET_OUT_MS,
  animateAppear,
  animateEnter,
  animateNumber,
  animatePulse,
  animateSheetIn,
  animateSheetOut,
  animateToastIn,
  animateToastOut,
  easeOutQuint,
  scrollPositionAt,
  staggerDelayMs,
  transitionDuration,
  transitionStyle,
} from "./motion";

// Как withControlledRaf в animateAppear ниже, но поддерживает НЕСКОЛЬКО
// одновременных цепочек rAF — animateSheetIn/Out гоняют панель и подложку
// раздельными вызовами animateNumber/animateOpacity, и однослотовый pending
// (как у animateNumber-теста) терял бы второй колбэк.
function withControlledRafQueue<T>(run: (tick: (now: number) => void) => T): T {
  let queue: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { queue.push(cb); return queue.length; }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  const tick = (now: number) => {
    const due = queue;
    queue = [];
    due.forEach((cb) => cb(now));
  };
  try {
    return run(tick);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

function fakeSheetElement(): HTMLElement {
  return { style: { opacity: "", transform: "" } } as unknown as HTMLElement;
}

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

describe("animateAppear", () => {
  // requestAnimationFrame стоит на месте: rAF в jsdom не тикает сам, поэтому
  // проверяем это через синхронный контроль кадров, как animateNumber выше.
  function withControlledRaf<T>(run: (tick: (now: number) => void) => T): T {
    let pending: FrameRequestCallback | null = null;
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { pending = cb; return 1; }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    try {
      return run((now) => pending!(now));
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    }
  }

  // Файл рассчитан на node-окружение (без jsdom), как остальные тесты этого
  // модуля — animateAppear трогает только el.style, поэтому хватает заглушки.
  function fakeElement(): HTMLElement {
    return { style: { opacity: "", transform: "" } } as unknown as HTMLElement;
  }

  it("обычный режим — двигает и opacity, и transform", () => {
    withControlledRaf((tick) => {
      const el = fakeElement();
      animateAppear(el, false);
      tick(0);
      // Первый кадр — ещё исходное состояние: сдвиг виден, элемент прозрачен.
      expect(el.style.opacity).toBe("0");
      expect(el.style.transform).toContain("6px");
      tick(ONBOARDING_APPEAR_MS);
      expect(el.style.opacity).toBe("1");
      expect(el.style.transform).toBe("");
    });
  });

  it("«уменьшить движение» — только затухание, без сдвига, и НЕ мгновенно", () => {
    withControlledRaf((tick) => {
      const el = fakeElement();
      animateAppear(el, true);
      tick(0);
      expect(el.style.opacity).toBe("0");
      expect(el.style.transform).toBe("");
      // Длительность не схлопнута в ноль: на середине пути — промежуточное
      // значение, а не сразу конечное (ровно тот баг, из-за которого фикс).
      tick(ONBOARDING_APPEAR_MS / 2);
      const mid = Number(el.style.opacity);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
    });
  });

  it("возвращает функцию отмены", () => {
    withControlledRaf(() => {
      const el = fakeElement();
      const cancel = animateAppear(el, false);
      expect(() => cancel()).not.toThrow();
    });
  });
});

describe("animateSheetIn", () => {
  it("обычный режим — сразу выставляет исходное положение синхронно", () => {
    withControlledRafQueue(() => {
      const panel = fakeSheetElement();
      const backdrop = fakeSheetElement();
      animateSheetIn(panel, backdrop, false);
      // До первого rAF-тика — потому и обязателен useLayoutEffect у вызывающего:
      // если бы это применялось только внутри rAF, один кадр отрисовался бы в
      // конечном положении раньше, чем встанет исходное.
      expect(panel.style.opacity).toBe("0.86");
      expect(panel.style.transform).toContain("32px");
      expect(backdrop.style.opacity).toBe("0");
    });
  });

  it("обычный режим — к концу анимации оба элемента полностью видимы", () => {
    withControlledRafQueue((tick) => {
      const panel = fakeSheetElement();
      const backdrop = fakeSheetElement();
      animateSheetIn(panel, backdrop, false);
      tick(0);
      tick(SHEET_IN_MS);
      expect(panel.style.opacity).toBe("1");
      expect(panel.style.transform).toBe("");
      expect(backdrop.style.opacity).toBe("1");
    });
  });

  it("«уменьшить движение» — без сдвига, но не мгновенно", () => {
    withControlledRafQueue((tick) => {
      const panel = fakeSheetElement();
      const backdrop = fakeSheetElement();
      animateSheetIn(panel, backdrop, true);
      expect(panel.style.opacity).toBe("0");
      expect(panel.style.transform).toBe("");
      tick(0);
      tick(FADE_MS / 2);
      const mid = Number(panel.style.opacity);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
    });
  });

  it("возвращает функцию отмены обеих цепочек", () => {
    withControlledRafQueue(() => {
      const cancel = animateSheetIn(fakeSheetElement(), fakeSheetElement(), false);
      expect(() => cancel()).not.toThrow();
    });
  });
});

describe("animateSheetOut", () => {
  it("done вызывается по завершении, не раньше", () => {
    withControlledRafQueue((tick) => {
      const panel = fakeSheetElement();
      const backdrop = fakeSheetElement();
      let finished = false;
      animateSheetOut(panel, backdrop, () => { finished = true; }, false);
      tick(0);
      expect(finished).toBe(false);
      tick(SHEET_OUT_MS);
      expect(finished).toBe(true);
      expect(panel.style.opacity).toBe("0");
      expect(backdrop.style.opacity).toBe("0");
    });
  });

  it("«уменьшить движение» — done тоже не мгновенно", () => {
    withControlledRafQueue((tick) => {
      const panel = fakeSheetElement();
      const backdrop = fakeSheetElement();
      let finished = false;
      animateSheetOut(panel, backdrop, () => { finished = true; }, true);
      tick(0);
      tick(FADE_MS / 2);
      expect(finished).toBe(false);
      tick(FADE_MS);
      expect(finished).toBe(true);
    });
  });
});

describe("staggerDelayMs", () => {
  it("растёт на 24мс за карточку и упирается в потолок 72мс", () => {
    expect(staggerDelayMs(0)).toBe(0);
    expect(staggerDelayMs(1)).toBe(24);
    expect(staggerDelayMs(2)).toBe(48);
    expect(staggerDelayMs(3)).toBe(72);
    expect(staggerDelayMs(20)).toBe(72);
  });
});

describe("animateEnter", () => {
  it("fadeUp — сразу исходное положение синхронно, к концу — на месте", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animateEnter(el, "fadeUp", false);
      expect(el.style.opacity).toBe("0");
      expect(el.style.transform).toContain("6px");
      tick(0);
      tick(190);
      expect(el.style.opacity).toBe("1");
      expect(el.style.transform).toBe("");
    });
  });

  it("pop — стартует с масштаба .98, к концу — масштаб 1", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animateEnter(el, "pop", false);
      expect(el.style.transform).toContain("0.98");
      tick(0);
      tick(190);
      expect(el.style.opacity).toBe("1");
      expect(el.style.transform).toBe("");
    });
  });

  it("fade — стартует с .72 (как переход между страницами), не с нуля", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animateEnter(el, "fade", false);
      expect(el.style.opacity).toBe("0.72");
      tick(0);
      tick(150);
      expect(el.style.opacity).toBe("1");
    });
  });

  it("«уменьшить движение» — fadeUp/pop без сдвига и масштаба, но не мгновенно", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animateEnter(el, "fadeUp", true);
      expect(el.style.opacity).toBe("0");
      expect(el.style.transform).toBe("");
      tick(0);
      tick(FADE_MS / 2);
      const mid = Number(el.style.opacity);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
    });
  });

  it("возвращает функцию отмены", () => {
    withControlledRafQueue(() => {
      const cancel = animateEnter(fakeSheetElement(), "fadeUp", false);
      expect(() => cancel()).not.toThrow();
    });
  });
});

describe("animateEnter — задержка (замена .stagger)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("исходный кадр стоит сразу, а само проявление стартует только после delayMs", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animateEnter(el, "fadeUp", false, 100);
      // Кадр «до» виден сразу — иначе элемент был бы полностью непрозрачным
      // все 100мс задержки, а не терпеливо ждал в скрытом виде.
      expect(el.style.opacity).toBe("0");
      vi.advanceTimersByTime(50);
      expect(el.style.opacity).toBe("0"); // ещё не стартовало
      vi.advanceTimersByTime(50); // ровно delayMs — таймер сработал
      tick(0);
      tick(190);
      expect(el.style.opacity).toBe("1");
    });
  });
});

describe("animateToastIn / animateToastOut", () => {
  it("вход — сдвиг+масштаб от исходного к полному", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animateToastIn(el, false);
      expect(el.style.opacity).toBe("0");
      expect(el.style.transform).toContain("8px");
      tick(0);
      tick(190);
      expect(el.style.opacity).toBe("1");
      expect(el.style.transform).toBe("");
    });
  });

  it("выход — от полного к нулю, без done (Toaster сам снимает тост таймером)", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animateToastOut(el, false);
      tick(0);
      tick(150);
      expect(el.style.opacity).toBe("0");
    });
  });
});

describe("animatePulse", () => {
  it("обычный режим — растёт до масштаба 1.18, потом возвращается к 1", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animatePulse(el, false);
      tick(0); // фаза роста, кадр 0: анкер старта
      tick(85); // конец фазы роста — пик
      expect(el.style.transform).toBe("scale(1.18)");
      tick(0); // фаза спада, кадр 0
      tick(105); // конец фазы спада
      expect(el.style.transform).toBe("");
    });
  });

  it("«уменьшить движение» — масштаб не трогаем, только вспышка прозрачности", () => {
    withControlledRafQueue((tick) => {
      const el = fakeSheetElement();
      animatePulse(el, true);
      tick(0);
      tick(FADE_MS);
      expect(el.style.opacity).toBe("1");
      expect(el.style.transform).toBe("");
    });
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
