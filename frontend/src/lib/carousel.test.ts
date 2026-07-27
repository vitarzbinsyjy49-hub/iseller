import { describe, expect, it } from "vitest";
import {
  indexFromScroll,
  isSlideMounted,
  isTapGesture,
} from "./carousel";

describe("isSlideMounted", () => {
  it("монтируются только активный и соседи", () => {
    expect(isSlideMounted(0, 0)).toBe(true);
    expect(isSlideMounted(1, 0)).toBe(true);
    expect(isSlideMounted(2, 0)).toBe(false);
    expect(isSlideMounted(5, 6)).toBe(true);
  });
});

describe("isTapGesture", () => {
  it("палец не сдвинулся и скролл не поехал — тап (открыть товар)", () => {
    expect(isTapGesture(0, 0, 0)).toBe(true);
    expect(isTapGesture(3, 2, 0)).toBe(true);
  });
  it("сдвиг пальца выше порога — листание, не тап", () => {
    expect(isTapGesture(20, 0, 0)).toBe(false);
    expect(isTapGesture(0, 20, 0)).toBe(false);
  });
  it("карусель фактически проскроллилась — листание, даже если палец почти на месте", () => {
    expect(isTapGesture(2, 2, 40)).toBe(false);
    expect(isTapGesture(2, 2, -40)).toBe(false);
  });
  it("субпиксельный дрейф scrollLeft не ломает тап", () => {
    expect(isTapGesture(1, 1, 0.5)).toBe(true);
  });
});

describe("indexFromScroll", () => {
  it("округляет позицию до индекса, зажимает в границы", () => {
    expect(indexFromScroll(0, 300, 5)).toBe(0);
    expect(indexFromScroll(310, 300, 5)).toBe(1);
    expect(indexFromScroll(9999, 300, 5)).toBe(4);
    expect(indexFromScroll(100, 0, 5)).toBe(0);
  });
});
