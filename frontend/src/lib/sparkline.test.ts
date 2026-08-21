import { describe, expect, it } from "vitest";
import { toSparklinePoints } from "./sparkline";

describe("toSparklinePoints", () => {
  it("пустой массив — пустая строка точек", () => {
    expect(toSparklinePoints([], 320, 80)).toBe("");
  });

  it("одна точка — не падает, ставит точку по центру высоты", () => {
    const points = toSparklinePoints([91.23], 320, 80);
    expect(points).toBe("0,40");
  });

  it("минимум и максимум упираются в края высоты (с учётом инверсии Y)", () => {
    const points = toSparklinePoints([90, 92], 100, 80);
    const [[, y1], [, y2]] = points.split(" ").map((p) => p.split(",").map(Number));
    // SVG Y растёт вниз: меньшее значение (90) — внизу (y больше), большее (92) — вверху.
    expect(y1).toBeGreaterThan(y2);
    expect(Math.min(y1, y2)).toBeCloseTo(0, 5);
    expect(Math.max(y1, y2)).toBeCloseTo(80, 5);
  });

  it("равные значения — не делит на ноль, рисует плоскую линию по центру", () => {
    const points = toSparklinePoints([91, 91, 91], 100, 80);
    const ys = points.split(" ").map((p) => Number(p.split(",")[1]));
    expect(ys.every((y) => y === 40)).toBe(true);
  });

  it("X растягивается по всей ширине от 0 до width", () => {
    const points = toSparklinePoints([1, 2, 3, 4], 300, 80);
    const xs = points.split(" ").map((p) => Number(p.split(",")[0]));
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(300);
  });
});
