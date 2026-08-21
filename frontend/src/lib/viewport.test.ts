import { describe, expect, it } from "vitest";
import {
  bottomNavStack,
  computeSafeArea,
  formatCssVars,
  imagePaddingClass,
  isKeyboardOpen,
  pickViewportHeight,
  sheetMaxHeightPx,
} from "./viewport";

describe("pickViewportHeight", () => {
  it("предпочитает Telegram viewportStableHeight", () => {
    expect(
      pickViewportHeight({
        tgViewportStableHeight: 832,
        tgViewportHeight: 900,
        visualViewportHeight: 852,
        windowInnerHeight: 852,
      })
    ).toBe(832);
  });

  it("падает по цепочке: stable → viewportHeight → visualViewport → innerHeight", () => {
    expect(
      pickViewportHeight({ tgViewportStableHeight: null, tgViewportHeight: 812, visualViewportHeight: 800 })
    ).toBe(812);
    expect(pickViewportHeight({ visualViewportHeight: 799.6 })).toBe(800);
    expect(pickViewportHeight({ windowInnerHeight: 667 })).toBe(667);
  });

  it("игнорирует нули, отрицательные и NaN", () => {
    expect(
      pickViewportHeight({ tgViewportStableHeight: 0, tgViewportHeight: -5, visualViewportHeight: NaN, windowInnerHeight: 731 })
    ).toBe(731);
  });

  it("возвращает null, когда источников нет (сработает CSS fallback)", () => {
    expect(pickViewportHeight({})).toBeNull();
  });
});

describe("computeSafeArea", () => {
  it("вне Telegram отдаёт css-env и нули (JS-переменные не ставятся)", () => {
    expect(computeSafeArea({ insideTelegram: false, isFullscreen: false, tgSafeTop: 59 })).toEqual({
      top: 0,
      bottom: 0,
      source: "css-env",
    });
  });

  it("fullscreen: top = safeAreaInset.top + contentSafeAreaInset.top (iPhone Pro Max)", () => {
    const r = computeSafeArea({
      insideTelegram: true,
      isFullscreen: true,
      tgSafeTop: 59,
      tgSafeBottom: 34,
      tgContentSafeTop: 46,
      tgContentSafeBottom: 0,
    });
    expect(r).toEqual({ top: 105, bottom: 34, source: "telegram-fullscreen" });
  });

  it("обычный режим: top НЕ включает safeAreaInset (webview уже под шапкой Telegram)", () => {
    const r = computeSafeArea({
      insideTelegram: true,
      isFullscreen: false,
      tgSafeTop: 59,
      tgSafeBottom: 34,
      tgContentSafeTop: 0,
    });
    expect(r.top).toBe(0);
    expect(r.bottom).toBe(34);
    expect(r.source).toBe("telegram");
  });

  it("нет двойного safe-area: telegram-источник исключает env (env остаётся только CSS-fallback'ом)", () => {
    // Контракт: любой источник, кроме css-env, означает «JS ставит переменную,
    // env()-fallback в CSS не срабатывает». Достаточно, чтобы источники были
    // взаимоисключающими.
    const inTg = computeSafeArea({ insideTelegram: true, isFullscreen: true, tgSafeTop: 47, tgContentSafeTop: 46 });
    expect(inTg.source).not.toBe("css-env");
    const outTg = computeSafeArea({ insideTelegram: false, isFullscreen: false });
    expect(outTg.source).toBe("css-env");
  });

  it("bottom = max(safeBottom, contentSafeBottom), не сумма", () => {
    const r = computeSafeArea({
      insideTelegram: true,
      isFullscreen: true,
      tgSafeBottom: 34,
      tgContentSafeBottom: 20,
    });
    expect(r.bottom).toBe(34);
  });
});

describe("formatCssVars", () => {
  it("числа форматирует в px с округлением, null оставляет null (переменная удаляется)", () => {
    expect(formatCssVars({ "--a": 831.6, "--b": null, "--c": 0 })).toEqual({
      "--a": "832px",
      "--b": null,
      "--c": "0px",
    });
  });

  it("NaN/Infinity → null", () => {
    expect(formatCssVars({ "--a": NaN, "--b": Infinity })).toEqual({ "--a": null, "--b": null });
  });
});

describe("sheetMaxHeightPx", () => {
  it("88% в один столбец, 90% от sm и шире", () => {
    expect(sheetMaxHeightPx(800, false)).toBe(704);
    expect(sheetMaxHeightPx(800, true)).toBe(720);
  });
});

describe("isKeyboardOpen", () => {
  it("true при просадке высоты больше 150px", () => {
    expect(isKeyboardOpen(500, 852)).toBe(true);
  });
  it("false при малых изменениях и отсутствии данных", () => {
    expect(isKeyboardOpen(800, 852)).toBe(false);
    expect(isKeyboardOpen(null, 852)).toBe(false);
    expect(isKeyboardOpen(500, null)).toBe(false);
  });
});

describe("bottomNavStack (нижний стек CTA/навбар, v5.2.7)", () => {
  it("зазор CTA над навбаром = 16px в любой safe-area (нет наезда за навбар)", () => {
    for (const safe of [0, 8, 20, 34, 44]) {
      expect(bottomNavStack(safe).clearance).toBe(16);
    }
  });

  it("safe-area учтена ОДИН раз: навбар и позиция CTA растут на ту же величину", () => {
    const flat = bottomNavStack(0);
    const notched = bottomNavStack(34);
    // effSafe = max(8, safe): при 34 обе величины больше ровно на 34-8=26
    expect(notched.navHeight - flat.navHeight).toBe(26);
    expect(notched.ctaBottomOffset - flat.ctaBottomOffset).toBe(26);
  });

  it("iPhone Pro Max (safe=34): CTA стоит выше навбара, не за ним", () => {
    const s = bottomNavStack(34);
    expect(s.navHeight).toBe(64 + 34); // 98
    expect(s.ctaBottomOffset).toBe(64 + 34 + 16); // 114 — выше верхней кромки навбара
    expect(s.ctaBottomOffset).toBeGreaterThan(s.navHeight);
  });

  it("минимум навбара 8px (max(0.5rem,…)) при нулевой/некорректной safe-area", () => {
    expect(bottomNavStack(0).navHeight).toBe(64 + 8);
    expect(bottomNavStack(-5).navHeight).toBe(64 + 8);
    expect(bottomNavStack(NaN).navHeight).toBe(64 + 8);
  });

  it("контент не уходит под панель: pb > низ кнопки + высота бара над кнопкой (~64px)", () => {
    const BAR_ABOVE_BUTTON = 64;
    for (const safe of [0, 34]) {
      const s = bottomNavStack(safe);
      expect(s.contentPadBottom).toBeGreaterThan(s.ctaBottomOffset + BAR_ABOVE_BUTTON);
    }
  });
});

describe("imagePaddingClass (режим изображения ProductCard)", () => {
  it("обычные фото — стандартный отступ", () => {
    // v5.6.0: обе ступени подняты на шаг (p-2/p-1 -> p-3/p-2). Фотографии не
    // хватало воздуха: товар упирался в края плитки, и рядом с ценой и кнопкой
    // это читалось как теснота, а не как витрина.
    expect(imagePaddingClass(1000, 1000)).toBe("p-3");
    expect(imagePaddingClass(800, 1000)).toBe("p-3");
  });
  it("сильно вытянутые (портрет и ландшафт) — уменьшенный отступ", () => {
    expect(imagePaddingClass(600, 1200)).toBe("p-2"); // Dyson/стик вертикальный
    expect(imagePaddingClass(1600, 900)).toBe("p-2"); // широкий MacBook-баннер
  });
  it("нулевые размеры не ломают рендер", () => {
    expect(imagePaddingClass(0, 0)).toBe("p-3");
  });
  it("вытянутое фото всегда получает меньше отступа, чем обычное", () => {
    // Отношение ступеней важнее их абсолютных значений: вытянутый кадр и так
    // занимает меньше квадрата, и одинаковый отступ сделал бы товар мельче.
    expect(imagePaddingClass(600, 1200)).not.toBe(imagePaddingClass(1000, 1000));
  });
});
