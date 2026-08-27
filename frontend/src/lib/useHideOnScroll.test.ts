import { describe, expect, it } from "vitest";
import { MOVE_EPS_PX, nextToolbarHidden, REVEAL_ZONE_PX } from "./useHideOnScroll";

describe("nextToolbarHidden", () => {
  const deep = REVEAL_ZONE_PX + 200;

  it("прокрутка вниз в глубине списка прячет панель", () => {
    expect(nextToolbarHidden(false, deep, 40)).toBe(true);
  });

  it("прокрутка вверх возвращает её сразу, без порога расстояния", () => {
    expect(nextToolbarHidden(true, deep, -MOVE_EPS_PX)).toBe(false);
  });

  it("у верха списка панель видна всегда, куда бы ни двигали", () => {
    expect(nextToolbarHidden(true, 0, 40)).toBe(false);
    expect(nextToolbarHidden(true, REVEAL_ZONE_PX, 40)).toBe(false);
    // Отрицательная позиция — оттягивание списка вниз на iOS.
    expect(nextToolbarHidden(true, -60, 40)).toBe(false);
  });

  it("дрожание пальца ничего не меняет", () => {
    expect(nextToolbarHidden(false, deep, MOVE_EPS_PX - 1)).toBe(false);
    expect(nextToolbarHidden(true, deep, -(MOVE_EPS_PX - 1))).toBe(true);
  });
});
