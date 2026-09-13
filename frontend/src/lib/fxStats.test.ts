import { describe, expect, it } from "vitest";
import { changeOver, fxStats, positionInRange } from "./fxStats";

/** Показатели курса считаются ИЗ ТОЙ ЖЕ истории, что уже приходит на график —
 *  ходить за ними на сервер не нужно. Здесь проверяется арифметика, потому что
 *  ошибка в ней не видна глазом: «+0,9%» и «−0,9%» выглядят одинаково
 *  правдоподобно, а решение человек принимает по знаку. */

const points = (...vals: number[]) =>
  vals.map((value, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, value }));

describe("fxStats", () => {
  it("берёт минимум, максимум и среднее", () => {
    const s = fxStats(points(80, 90, 100))!;
    expect(s.min).toBe(80);
    expect(s.max).toBe(100);
    expect(s.avg).toBe(90);
  });

  it("последняя точка — это «сегодня»", () => {
    // История приходит по возрастанию даты; брать первую значило бы показывать
    // курс месячной давности как текущий.
    expect(fxStats(points(80, 90, 100))!.last).toBe(100);
  });

  it("отклонение от среднего — в процентах и со знаком", () => {
    const s = fxStats(points(80, 90, 100))!;
    // 100 против среднего 90 => +11,1%
    expect(s.vsAvgPercent).toBeCloseTo(11.11, 1);
  });

  it("пустая история — null, а не нули", () => {
    // Нули нарисовали бы «курс 0 ₽» и «−100%» на совершенно исправном экране.
    expect(fxStats([])).toBeNull();
  });

  it("одна точка — диапазон вырожден, но считается", () => {
    const s = fxStats(points(84))!;
    expect(s.min).toBe(84);
    expect(s.max).toBe(84);
    expect(s.vsAvgPercent).toBe(0);
  });
});

describe("changeOver", () => {
  it("сравнивает последнюю точку с точкой N дней назад", () => {
    // 5 точек, окно 2 дня: сравниваем последнюю (104) с третьей с конца (102).
    expect(changeOver(points(100, 101, 102, 103, 104), 2)).toBeCloseTo(1.96, 1);
  });

  it("падение даёт отрицательное число", () => {
    expect(changeOver(points(100, 90), 1)).toBeCloseTo(-10, 1);
  });

  it("истории короче окна — null, а не сравнение с чем попало", () => {
    // Соблазн сравнить с самой ранней точкой велик, но тогда подпись «за 30
    // дней» соврёт: данных за 30 дней у нас нет.
    expect(changeOver(points(100, 101), 10)).toBeNull();
  });
});

describe("positionInRange", () => {
  it("у нижней границы — 0, у верхней — 1", () => {
    expect(positionInRange(80, 80, 100)).toBe(0);
    expect(positionInRange(100, 80, 100)).toBe(1);
  });

  it("посередине — 0,5", () => {
    expect(positionInRange(90, 80, 100)).toBe(0.5);
  });

  it("вырожденный диапазон не делит на ноль", () => {
    // Курс не менялся месяц: min === max. Без защиты здесь NaN, и отметка
    // уезжает из шкалы.
    expect(positionInRange(84, 84, 84)).toBe(0.5);
  });
});
