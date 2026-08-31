import { describe, expect, it } from "vitest";
import { COLLAPSE_DISTANCE_PX, collapseProgress } from "./useCollapsingHeader";

describe("схлопывание крупного заголовка", () => {
  it("в покое заголовок цел, шапка без стекла", () => {
    expect(collapseProgress(0)).toBe(0);
  });

  it("на полной дистанции заголовок убран", () => {
    expect(collapseProgress(COLLAPSE_DISTANCE_PX)).toBe(1);
  });

  it("на середине дистанции — половина", () => {
    expect(collapseProgress(COLLAPSE_DISTANCE_PX / 2)).toBeCloseTo(0.5, 5);
  });

  it("растёт монотонно — заголовок не может проявиться обратно по ходу вниз", () => {
    let prev = -1;
    for (let top = 0; top <= COLLAPSE_DISTANCE_PX * 2; top += 4) {
      const p = collapseProgress(top);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  /** iOS отдаёт отрицательный scrollTop при оттягивании ленты вниз. Без зажима
   *  заголовок получил бы opacity больше единицы и transform в другую сторону —
   *  то есть на резинке верх бы дёргался. */
  it("оттягивание вниз (отрицательная позиция) не выводит за границы", () => {
    expect(collapseProgress(-40)).toBe(0);
    expect(collapseProgress(-0.5)).toBe(0);
  });

  it("прокрутка далеко вниз не выводит за границы", () => {
    expect(collapseProgress(5000)).toBe(1);
  });

  it("значение всегда в [0, 1] — им напрямую красится opacity", () => {
    for (const top of [-1000, -1, 0, 0.5, 17, 71.6, 72, 73, 1e6]) {
      const p = collapseProgress(top);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(Number.isFinite(p)).toBe(true);
    }
  });

  /** Дистанция приходит из разметки и теоретически может оказаться нулевой
   *  (заголовок ещё не смерян). Деление на ноль дало бы NaN, а NaN в opacity —
   *  это молча пропавший заголовок. */
  it("нулевая дистанция не даёт NaN", () => {
    expect(collapseProgress(0, 0)).toBe(0);
    expect(collapseProgress(10, 0)).toBe(1);
  });
});
