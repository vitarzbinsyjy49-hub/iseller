import { describe, expect, it } from "vitest";
import {
  bottomNavStack,
  brandMarkVisible,
  computeSafeArea,
  formatCssVars,
  dropdownMaxHeightPx,
  imagePaddingClass,
  isKeyboardOpen,
  pickViewportHeight,
  sheetMaxHeightPx,
  shouldLockOrientation,
  overlayViewportBox,
  searchPanelMaxHeightPx,
  navRowKeyboardBottomPx,
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

  it("плавающая пилюля добавляет зазор ОДИН раз, поверх safe-area", () => {
    // 64 контент + max(8, safe) + 10 зазора
    expect(bottomNavStack(0).navHeight).toBe(64 + 8 + 10);
    expect(bottomNavStack(-5).navHeight).toBe(64 + 8 + 10);
    expect(bottomNavStack(NaN).navHeight).toBe(64 + 8 + 10);
  });

  it("на устройстве с вырезом safe-area прибавляется вместо минимума, а не к нему", () => {
    const s = bottomNavStack(34);
    expect(s.navHeight).toBe(64 + 34 + 10); // 108, а не 64+8+34+10
  });

  it("разница между вырезом и плоским низом равна разнице safe-area", () => {
    const notched = bottomNavStack(34);
    const flat = bottomNavStack(8);
    expect(notched.navHeight - flat.navHeight).toBe(26);
  });

  it("кнопка дока по-прежнему стоит выше навигации", () => {
    const s = bottomNavStack(34);
    expect(s.ctaBottomOffset).toBeGreaterThan(s.navHeight);
    expect(s.clearance).toBe(16);
  });

  it("отступ контента под навигацией считает safe-area один раз", () => {
    // 64 контент + 34 safe + 10 зазор + 12 запас = 120, а не 128 (с двойным safe)
    expect(bottomNavStack(34).navContentPadBottom).toBe(64 + 34 + 10 + 12);
    expect(bottomNavStack(0).navContentPadBottom).toBe(64 + 8 + 10 + 12);
  });
});

describe("dropdownMaxHeightPx", () => {
  it("отдаёт всё свободное место под панелью", () => {
    expect(dropdownMaxHeightPx(200, 812)).toBe(600);
  });

  it("сжимается вместе с видимой областью, когда открыта клавиатура", () => {
    // 812 -> 380: без этого панель ограничивалась бы 60vh от НЕИЗМЕННОЙ высоты
    // и нижним краем уходила под клавиатуру, а её последняя строка
    // («Спросить AI») становилась недостижимой даже прокруткой.
    expect(dropdownMaxHeightPx(200, 380)).toBe(180);
    expect(dropdownMaxHeightPx(200, 500)).toBe(288);
  });

  it("не схлопывается в полоску, как бы мало места ни осталось", () => {
    expect(dropdownMaxHeightPx(300, 320)).toBe(180);
    expect(dropdownMaxHeightPx(500, 300)).toBe(180);
  });

  it("оставляет зазор до нижней кромки", () => {
    expect(dropdownMaxHeightPx(100, 812, 12)).toBe(700);
    expect(dropdownMaxHeightPx(100, 812, 0)).toBe(712);
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

describe("brandMarkVisible", () => {
  it("вне Telegram знака нет: полосы кнопок не существует", () => {
    expect(brandMarkVisible({ insideTelegram: false, isFullscreen: true, contentSafeTop: 46 })).toBe(false);
  });

  it("в Telegram без fullscreen знака нет: шапка Telegram вне webview", () => {
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: false, contentSafeTop: 46 })).toBe(false);
  });

  it("fullscreen с нулевой полосой не показывает знак: рисовать его негде", () => {
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: true, contentSafeTop: 0 })).toBe(false);
  });

  it("fullscreen с ненулевой полосой показывает знак", () => {
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: true, contentSafeTop: 46 })).toBe(true);
  });

  it("отсутствующая величина полосы читается как ноль, а не как истина", () => {
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: true, contentSafeTop: null })).toBe(false);
    expect(brandMarkVisible({ insideTelegram: true, isFullscreen: true, contentSafeTop: NaN })).toBe(false);
  });
});

describe("shouldLockOrientation", () => {
  const base = { supported: true, alreadyLocked: false, portrait: true };

  it("закрепляет портрет, когда клиент умеет и ещё не закреплено", () => {
    expect(shouldLockOrientation(base)).toBe(true);
  });

  it("НЕ закрепляет альбомную: lockOrientation фиксирует текущую ориентацию, и мы заморозили бы сломанную раскладку", () => {
    expect(shouldLockOrientation({ ...base, portrait: false })).toBe(false);
  });

  it("не повторяет вызов, если уже закреплено", () => {
    expect(shouldLockOrientation({ ...base, alreadyLocked: true })).toBe(false);
  });

  it("не трогает старый клиент без метода", () => {
    expect(shouldLockOrientation({ ...base, supported: false })).toBe(false);
  });
});

describe("overlayViewportBox", () => {
  it("без visualViewport занимает всё окно — поведение как до правки", () => {
    expect(overlayViewportBox({ windowHeight: 812 })).toEqual({ top: 0, height: 812 });
    expect(overlayViewportBox({ vvHeight: null, windowHeight: 812 })).toEqual({ top: 0, height: 812 });
    expect(overlayViewportBox({ vvHeight: NaN, windowHeight: 812 })).toEqual({ top: 0, height: 812 });
    expect(overlayViewportBox({ vvHeight: 0, windowHeight: 812 })).toEqual({ top: 0, height: 812 });
  });

  it("с открытой клавиатурой берёт высоту ВИДИМОЙ области, а не окна", () => {
    // 812 окно, ~336 занято клавиатурой
    expect(overlayViewportBox({ vvHeight: 476, windowHeight: 812 })).toEqual({ top: 0, height: 476 });
  });

  it("учитывает подскролл страницы под клавиатуру", () => {
    expect(overlayViewportBox({ vvHeight: 476, vvOffsetTop: 60, windowHeight: 812 }))
      .toEqual({ top: 60, height: 476 });
  });

  it("отрицательный и битый offsetTop читается как ноль, а не сдвигает панель вверх", () => {
    expect(overlayViewportBox({ vvHeight: 476, vvOffsetTop: -20, windowHeight: 812 }).top).toBe(0);
    expect(overlayViewportBox({ vvHeight: 476, vvOffsetTop: NaN, windowHeight: 812 }).top).toBe(0);
  });

  it("дробную высоту округляет: iOS отдаёт нецелые значения", () => {
    expect(overlayViewportBox({ vvHeight: 475.6, windowHeight: 812 }).height).toBe(476);
  });
});

describe("searchPanelMaxHeightPx", () => {
  it("62% от видимой высоты по умолчанию", () => {
    expect(searchPanelMaxHeightPx(800)).toBe(496);
  });

  it("другую долю можно задать явно", () => {
    expect(searchPanelMaxHeightPx(800, 0.5)).toBe(400);
  });

  it("отрицательная высота не даёт отрицательный результат", () => {
    expect(searchPanelMaxHeightPx(-100)).toBe(0);
  });
});

describe("navRowKeyboardBottomPx", () => {
  it("клавиатура закрыта — видимая область во всё окно, ряду поднимать не над чем", () => {
    expect(navRowKeyboardBottomPx({ top: 0, height: 812 }, 812)).toBe(0);
  });

  it("клавиатура открыла зазор снизу — ряд обязан подняться на его высоту", () => {
    // 812 окно, видимая область 476 — клавиатура забрала 336px снизу.
    expect(navRowKeyboardBottomPx({ top: 0, height: 476 }, 812)).toBe(336);
  });

  it("учитывает подскролл страницы (offsetTop) видимой области", () => {
    expect(navRowKeyboardBottomPx({ top: 60, height: 476 }, 812)).toBe(276);
  });

  it("не уходит в отрицательные значения при некорректном вводе", () => {
    expect(navRowKeyboardBottomPx({ top: 0, height: 900 }, 812)).toBe(0);
  });
});
