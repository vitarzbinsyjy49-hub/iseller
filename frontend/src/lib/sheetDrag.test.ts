import { describe, expect, it } from "vitest";
import {
  DISMISS_MIN_PX,
  DISMISS_RATIO,
  DRAG_START_PX,
  RUBBER_LIMIT_PX,
  isVerticalDrag,
  sheetBackdropOpacity,
  sheetDragOffset,
  shouldDismissSheet,
} from "./sheetDrag";

describe("sheetDragOffset", () => {
  it("вниз панель идёт за пальцем один к одному", () => {
    // Расхождение панели и пальца видно сразу: человек сравнивает движение с
    // собственной рукой, а не с эталоном плавности.
    expect(sheetDragOffset(0)).toBe(0);
    expect(sheetDragOffset(40)).toBe(40);
    expect(sheetDragOffset(300)).toBe(300);
  });

  it("вверх — с сопротивлением, но не игнорируя жест", () => {
    const small = sheetDragOffset(-20);
    expect(small).toBeLessThan(0);
    expect(Math.abs(small)).toBeLessThan(20);
  });

  it("вверх никогда не уходит дальше предела", () => {
    // Пускать шторку выше её высоты значит открывать пустоту над ней.
    for (const dy of [-50, -200, -1000, -100000]) {
      expect(Math.abs(sheetDragOffset(dy))).toBeLessThan(RUBBER_LIMIT_PX);
    }
  });

  it("чем сильнее тянут вверх, тем меньше отдача", () => {
    const a = Math.abs(sheetDragOffset(-20));
    const b = Math.abs(sheetDragOffset(-40));
    const c = Math.abs(sheetDragOffset(-80));
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(b - a).toBeGreaterThan(c - b);
  });
});

describe("sheetBackdropOpacity", () => {
  it("на месте подложка в полную силу", () => {
    expect(sheetBackdropOpacity(0, 600)).toBe(1);
    expect(sheetBackdropOpacity(-10, 600)).toBe(1);
  });

  it("гаснет вместе с уходом панели", () => {
    expect(sheetBackdropOpacity(300, 600)).toBeCloseTo(0.5, 5);
    expect(sheetBackdropOpacity(600, 600)).toBe(0);
  });

  it("ниже нуля не уходит", () => {
    expect(sheetBackdropOpacity(900, 600)).toBe(0);
  });

  it("нулевая высота не ломает расчёт", () => {
    expect(sheetBackdropOpacity(100, 0)).toBe(1);
  });
});

describe("shouldDismissSheet", () => {
  const H = 600;

  it("протянули достаточно далеко — закрываем", () => {
    expect(shouldDismissSheet({ offset: H * DISMISS_RATIO, height: H, elapsedMs: 3000 })).toBe(true);
  });

  it("протянули чуть-чуть и медленно — возвращаем", () => {
    expect(shouldDismissSheet({ offset: 40, height: H, elapsedMs: 3000 })).toBe(false);
  });

  it("дрожание пальца не закрывает, как бы быстро ни было", () => {
    // 12px за 2мс — это скорость 6 px/мс, в двенадцать раз выше порога. Без
    // минимального пути шторка закрывалась бы от дрожания руки при тапе
    // (поймано на живой проверке, а не придумано).
    expect(shouldDismissSheet({ offset: 12, height: H, elapsedMs: 2 })).toBe(false);
    expect(shouldDismissSheet({ offset: 31, height: H, elapsedMs: 1 })).toBe(false);
  });

  it("быстрый короткий флик закрывает вопреки малому пути", () => {
    // Только по расстоянию судить нельзя: флик проходит мало, но намерение
    // в нём такое же явное, как в долгом протягивании.
    expect(shouldDismissSheet({ offset: 60, height: H, elapsedMs: 100 })).toBe(true);
    // Ровно на границе минимального пути флик уже считается.
    expect(shouldDismissSheet({ offset: DISMISS_MIN_PX, height: H, elapsedMs: 20 })).toBe(true);
  });

  it("медленное протягивание в самый низ тоже закрывает", () => {
    // И только по скорости судить нельзя — это симметричный случай.
    expect(shouldDismissSheet({ offset: 500, height: H, elapsedMs: 4000 })).toBe(true);
  });

  it("движение вверх никогда не закрывает", () => {
    expect(shouldDismissSheet({ offset: -20, height: H, elapsedMs: 100 })).toBe(false);
    expect(shouldDismissSheet({ offset: 0, height: H, elapsedMs: 10 })).toBe(false);
  });

  it("нулевые размеры не приводят к закрытию", () => {
    expect(shouldDismissSheet({ offset: 100, height: 0, elapsedMs: 100 })).toBe(false);
  });

  it("нулевая длительность не даёт бесконечной скорости", () => {
    expect(shouldDismissSheet({ offset: 10, height: H, elapsedMs: 0 })).toBe(false);
  });
});

describe("isVerticalDrag", () => {
  it("дрожание пальца при тапе жестом не считается", () => {
    // Без порога нажатие на кнопку внутри шторки начинало бы её тащить.
    expect(isVerticalDrag(0, DRAG_START_PX - 1)).toBe(false);
    expect(isVerticalDrag(1, 2)).toBe(false);
  });

  it("явное вертикальное движение — жест", () => {
    expect(isVerticalDrag(2, 30)).toBe(true);
    expect(isVerticalDrag(0, -30)).toBe(true);
  });

  it("боковое движение отдаём лентам внутри шторки", () => {
    expect(isVerticalDrag(80, 20)).toBe(false);
    expect(isVerticalDrag(-80, 20)).toBe(false);
  });
});
