import { describe, expect, it } from "vitest";
import {
  MOVE_EPS_PX,
  nextToolbarHidden,
  REVEAL_ZONE_PX,
  TOOLBAR_GLASS_PX,
  toolbarGlassProgress,
} from "./useHideOnScroll";

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

describe("toolbarGlassProgress", () => {
  it("у кромки стекла нет: панель не должна класть плиту поверх живого фона", () => {
    expect(toolbarGlassProgress(0)).toBe(0);
    expect(toolbarGlassProgress(-40)).toBe(0);
  });

  it("наливается ПОСТЕПЕННО, а не порогом — в этом вся правка", () => {
    const half = toolbarGlassProgress(TOOLBAR_GLASS_PX / 2);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    // Прежнее бинарное поведение дало бы 1 уже здесь: прокрутка на пять
    // пикселей ставила сплошной фон поперёк градиента.
    expect(toolbarGlassProgress(5)).toBeLessThan(0.2);
  });

  it("дальше пути налива не растёт", () => {
    expect(toolbarGlassProgress(TOOLBAR_GLASS_PX)).toBe(1);
    expect(toolbarGlassProgress(TOOLBAR_GLASS_PX * 10)).toBe(1);
  });

  it("битое значение не ломает панель", () => {
    expect(toolbarGlassProgress(NaN)).toBe(0);
    expect(toolbarGlassProgress(Infinity)).toBe(0);
  });
});
