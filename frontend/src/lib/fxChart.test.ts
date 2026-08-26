import { describe, expect, it } from "vitest";
import { buildFxChart, type FxPoint } from "./fxChart";

const PLOT = { left: 42, right: 314, top: 10, bottom: 126 };

function series(values: number[]): FxPoint[] {
  // 1 августа 2026 и дальше по дню — даты нужны только подписям оси X.
  return values.map((value, index) => ({
    date: new Date(Date.UTC(2026, 7, 1 + index)).toISOString(),
    value,
  }));
}

function ys(line: string): number[] {
  return line.split(" ").map((pair) => Number(pair.split(",")[1]));
}

describe("buildFxChart", () => {
  it("меньше двух точек — графика нет", () => {
    // График из одной точки врёт сильнее, чем честная надпись «данных мало».
    expect(buildFxChart([], PLOT)).toBeNull();
    expect(buildFxChart(series([91]), PLOT)).toBeNull();
  });

  it("линия не упирается в края области — сверху и снизу остаются поля", () => {
    const chart = buildFxChart(series([90, 95]), PLOT)!;
    const [low, high] = ys(chart.line);
    expect(high).toBeGreaterThan(PLOT.top);
    expect(low).toBeLessThan(PLOT.bottom);
  });

  it("больший курс рисуется выше: в SVG ось Y растёт вниз", () => {
    const [y1, y2] = ys(buildFxChart(series([90, 92]), PLOT)!.line);
    expect(y1).toBeGreaterThan(y2);
  });

  it("плоский курс не делит на ноль и не изображает динамику", () => {
    const chart = buildFxChart(series([91, 91, 91]), PLOT)!;
    const values = ys(chart.line);
    expect(new Set(values).size).toBe(1);
    // Одна подпись цены вместо трёх одинаковых.
    expect(chart.yTicks).toHaveLength(1);
    expect(chart.yTicks[0].value).toBe(91);
  });

  it("линия занимает всю ширину области, а последняя точка стоит на её конце", () => {
    const chart = buildFxChart(series([90, 91, 92, 93]), PLOT)!;
    const xs = chart.line.split(" ").map((pair) => Number(pair.split(",")[0]));
    expect(xs[0]).toBe(PLOT.left);
    expect(xs[xs.length - 1]).toBe(PLOT.right);
    expect(chart.last.x).toBe(PLOT.right);
  });

  it("подписи цены — настоящие значения из данных, а не круглые числа", () => {
    // Круглое «92,00» на графике, где курс не был равен 92, обещает точку,
    // которой в данных нет.
    const chart = buildFxChart(series([90.15, 93.4, 91.2]), PLOT)!;
    expect(chart.yTicks.map((t) => t.value)).toEqual([93.4, (90.15 + 93.4) / 2, 90.15]);
  });

  it("заливка замкнута по нижней границе области", () => {
    const chart = buildFxChart(series([90, 92]), PLOT)!;
    expect(chart.area.startsWith(`${PLOT.left},${PLOT.bottom} `)).toBe(true);
    expect(chart.area.endsWith(` ${PLOT.right},${PLOT.bottom}`)).toBe(true);
  });

  it("три подписи дат: начало, середина, конец", () => {
    const chart = buildFxChart(series([90, 91, 92, 93, 94]), PLOT)!;
    expect(chart.xTicks).toHaveLength(3);
    expect(chart.xTicks[0].x).toBe(PLOT.left);
    expect(chart.xTicks[2].x).toBe(PLOT.right);
    expect(chart.xTicks.every((t) => t.label.length > 0)).toBe(true);
  });

  it("битая дата не роняет график — подпись просто пустая", () => {
    const points: FxPoint[] = [
      { date: "не дата", value: 90 },
      { date: "не дата", value: 91 },
    ];
    const chart = buildFxChart(points, PLOT)!;
    expect(chart.xTicks.map((t) => t.label)).toEqual(["", ""]);
  });
});
