import { describe, expect, it } from "vitest";
import {
  DEPTH_MS,
  PARALLAX_PCT,
  TAB_MS,
  dimsExitingLayer,
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
    // Порядок вкладок: / → /catalog → /ai → /requests → /profile
    expect(resolveRouteMotion("/", "/catalog", "PUSH")).toEqual({ kind: "tab", enterFrom: "right" });
    expect(resolveRouteMotion("/catalog", "/profile", "PUSH")).toEqual({ kind: "tab", enterFrom: "right" });
  });

  it("вкладка левее приезжает слева", () => {
    expect(resolveRouteMotion("/profile", "/", "PUSH")).toEqual({ kind: "tab", enterFrom: "left" });
  });

  it("вкладки остаются плоскостью и при POP", () => {
    // Возврат браузера между двумя вкладками — это всё ещё соседние экраны
    // одного уровня, а не выход из глубины: направление берём из их порядка.
    expect(resolveRouteMotion("/catalog", "/", "POP")).toEqual({ kind: "tab", enterFrom: "left" });
  });

  it("переход на вложенный экран — вглубь, справа", () => {
    expect(resolveRouteMotion("/catalog", "/product/7", "PUSH")).toEqual({
      kind: "depth", enterFrom: "right",
    });
  });

  it("возврат с вложенного экрана — слева", () => {
    expect(resolveRouteMotion("/product/7", "/catalog", "POP")).toEqual({
      kind: "depth", enterFrom: "left",
    });
  });

  it("переход между двумя вложенными экранами тоже вглубь", () => {
    // Из карточки товара в похожий товар: уровень не меняется, но это шаг
    // вперёд по истории, и назад из него ведёт кнопка «Назад».
    expect(resolveRouteMotion("/product/7", "/product/9", "PUSH")).toEqual({
      kind: "depth", enterFrom: "right",
    });
  });

  it("вложенные экраны вне списка вкладок не считаются вкладками", () => {
    // /favorites и /history — глубина, хотя это корневые пути.
    expect(resolveRouteMotion("/", "/favorites", "PUSH")).toEqual({
      kind: "depth", enterFrom: "right",
    });
  });
});

describe("routeMotionDuration", () => {
  it("вкладки быстрее, чем глубина", () => {
    expect(routeMotionDuration({ kind: "tab", enterFrom: "right" })).toBe(TAB_MS);
    expect(routeMotionDuration({ kind: "depth", enterFrom: "right" })).toBe(DEPTH_MS);
    expect(TAB_MS).toBeLessThan(DEPTH_MS);
  });

  it("длительности не выходят за границу, после которой переход читается как задержка", () => {
    expect(DEPTH_MS).toBeLessThanOrEqual(300);
    expect(TAB_MS).toBeLessThanOrEqual(300);
  });
});

describe("routeMotionOffsets", () => {
  it("вкладки идут на всю ширину в противоположные стороны", () => {
    expect(routeMotionOffsets({ kind: "tab", enterFrom: "right" })).toEqual({ enter: 100, exit: -100 });
    expect(routeMotionOffsets({ kind: "tab", enterFrom: "left" })).toEqual({ enter: -100, exit: 100 });
  });

  it("вперёд: новый экран во всю ширину, старый — на треть", () => {
    expect(routeMotionOffsets({ kind: "depth", enterFrom: "right" })).toEqual({
      enter: 100, exit: -PARALLAX_PCT,
    });
  });

  it("назад: уходящий во всю ширину, возвращающийся — с той же трети", () => {
    // Симметрия обязательна: экран должен вернуться ровно оттуда, куда ушёл,
    // иначе переход «туда-обратно» выглядит как два разных перехода.
    expect(routeMotionOffsets({ kind: "depth", enterFrom: "left" })).toEqual({
      enter: -PARALLAX_PCT, exit: 100,
    });
  });

  it("верхний слой всегда проходит больше нижнего — это и есть параллакс", () => {
    for (const enterFrom of ["left", "right"] as const) {
      const { enter, exit } = routeMotionOffsets({ kind: "depth", enterFrom });
      const top = Math.max(Math.abs(enter), Math.abs(exit));
      const bottom = Math.min(Math.abs(enter), Math.abs(exit));
      expect(top).toBeGreaterThan(bottom);
    }
  });

  it("без движения смещений нет", () => {
    expect(routeMotionOffsets({ kind: "none" })).toEqual({ enter: 0, exit: 0 });
  });
});

describe("dimsExitingLayer", () => {
  it("затемняет только тот слой, который уходит ПОД новый экран", () => {
    expect(dimsExitingLayer({ kind: "depth", enterFrom: "right" })).toBe(true);
    expect(dimsExitingLayer({ kind: "depth", enterFrom: "left" })).toBe(false);
    expect(dimsExitingLayer({ kind: "tab", enterFrom: "right" })).toBe(false);
    expect(dimsExitingLayer({ kind: "none" })).toBe(false);
  });
});
