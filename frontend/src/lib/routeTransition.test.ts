import { describe, expect, it } from "vitest";
import {
  TAB_MS,
  resolveRouteMotion,
  routeMotionDuration,
  routeMotionOffsets,
} from "./routeTransition";

describe("resolveRouteMotion", () => {
  it("не двигает экран, когда маршрут не сменился", () => {
    expect(resolveRouteMotion("/catalog", "/catalog", "PUSH")).toEqual({ kind: "none" });
  });

  it("не двигает экран на replace", () => {
    // Деплинк при старте приходит именно так: пользователь никуда не переходил,
    // и направления у этого перехода нет.
    expect(resolveRouteMotion("/", "/product/12", "REPLACE")).toEqual({ kind: "none" });
  });

  it("соседняя вкладка справа приезжает справа", () => {
    // Порядок вкладок: / → /catalog → /ai → /profile (/requests — вложенный экран, не вкладка)
    expect(resolveRouteMotion("/", "/catalog", "PUSH")).toEqual({ kind: "tab", enterFrom: "right" });
    expect(resolveRouteMotion("/catalog", "/profile", "PUSH")).toEqual({ kind: "tab", enterFrom: "right" });
  });

  it("вкладка левее приезжает слева", () => {
    expect(resolveRouteMotion("/profile", "/", "PUSH")).toEqual({ kind: "tab", enterFrom: "left" });
  });

  it("вкладки остаются плоскостью и при POP", () => {
    // Возврат браузера между двумя вкладками — это всё ещё соседние экраны
    // одного уровня: направление берём из их порядка, а не из истории.
    expect(resolveRouteMotion("/catalog", "/", "POP")).toEqual({ kind: "tab", enterFrom: "left" });
  });

  describe("вложенные экраны — без сдвига", () => {
    // Решение по итогам проверки на устройстве: вложенный экран подгружается
    // отдельным chunk'ом и запрашивает свои данные, то есть меняет содержимое
    // прямо посреди анимации. Сдвиг этот момент не сглаживает, а подчёркивает —
    // он обещает непрерывность, которой под ним нет.
    it("вход в карточку товара", () => {
      expect(resolveRouteMotion("/catalog", "/product/7", "PUSH")).toEqual({ kind: "none" });
      expect(resolveRouteMotion("/", "/product/7", "PUSH")).toEqual({ kind: "none" });
    });

    it("возврат из карточки товара", () => {
      expect(resolveRouteMotion("/product/7", "/catalog", "POP")).toEqual({ kind: "none" });
    });

    it("переход между двумя вложенными экранами", () => {
      expect(resolveRouteMotion("/product/7", "/product/9", "PUSH")).toEqual({ kind: "none" });
    });

    it("корневые пути вне списка вкладок вкладками не считаются", () => {
      // /favorites, /history, /cart — глубина, хотя путь короткий.
      expect(resolveRouteMotion("/", "/favorites", "PUSH")).toEqual({ kind: "none" });
      expect(resolveRouteMotion("/catalog", "/cart", "PUSH")).toEqual({ kind: "none" });
      // /requests переехал в профиль и тоже стал глубиной, а не плоскостью.
      expect(resolveRouteMotion("/profile", "/requests", "PUSH")).toEqual({ kind: "none" });
    });
  });
});

describe("routeMotionDuration", () => {
  it("сдвиг вкладок укладывается в порог, за которым переход читается как задержка", () => {
    expect(routeMotionDuration({ kind: "tab", enterFrom: "right" })).toBe(TAB_MS);
    expect(TAB_MS).toBeLessThanOrEqual(300);
  });

  it("без движения длительности нет", () => {
    expect(routeMotionDuration({ kind: "none" })).toBe(0);
  });
});

describe("routeMotionOffsets", () => {
  it("вкладки идут на всю ширину навстречу друг другу", () => {
    // Оба слоя проходят одинаковый путь: вкладки равноправны, ни одна не «под»
    // другой. Параллакс (разная скорость слоёв) обозначал бы вложенность,
    // которой между вкладками нет.
    expect(routeMotionOffsets({ kind: "tab", enterFrom: "right" })).toEqual({ enter: 100, exit: -100 });
    expect(routeMotionOffsets({ kind: "tab", enterFrom: "left" })).toEqual({ enter: -100, exit: 100 });
  });

  it("слои всегда расходятся в противоположные стороны", () => {
    for (const enterFrom of ["left", "right"] as const) {
      const { enter, exit } = routeMotionOffsets({ kind: "tab", enterFrom });
      expect(Math.sign(enter)).toBe(-Math.sign(exit));
      expect(Math.abs(enter)).toBe(Math.abs(exit));
    }
  });

  it("без движения смещений нет", () => {
    expect(routeMotionOffsets({ kind: "none" })).toEqual({ enter: 0, exit: 0 });
  });
});
