import { describe, expect, it } from "vitest";
import {
  classifySwipe,
  indexFromScroll,
  isSlideMounted,
  movedBeyondTap,
  nextIndex,
} from "./carousel";

describe("classifySwipe", () => {
  it("маленькое движение — тап (открыть товар)", () => {
    expect(classifySwipe(3, 2, 300)).toBe("tap");
    expect(classifySwipe(0, 0, 300)).toBe("tap");
  });
  it("явный горизонтальный размах — листание", () => {
    expect(classifySwipe(-120, 10, 300)).toBe("next");
    expect(classifySwipe(120, 10, 300)).toBe("prev");
  });
  it("вертикальный жест — не листание (скролл страницы), не тап", () => {
    expect(classifySwipe(10, 120, 300)).toBe("none");
  });
  it("небольшой горизонтальный сдвиг ниже порога — none (снап назад, без открытия)", () => {
    expect(classifySwipe(20, 4, 300)).toBe("none");
  });
});

describe("nextIndex", () => {
  it("границы без зацикливания", () => {
    expect(nextIndex(0, "prev", 3)).toBe(0);
    expect(nextIndex(2, "next", 3)).toBe(2);
    expect(nextIndex(1, "next", 3)).toBe(2);
    expect(nextIndex(1, "prev", 3)).toBe(0);
    expect(nextIndex(1, "tap", 3)).toBe(1);
    expect(nextIndex(1, "none", 3)).toBe(1);
  });
});

describe("movedBeyondTap", () => {
  it("подавляет клик после свайпа", () => {
    expect(movedBeyondTap(2, 2)).toBe(false);
    expect(movedBeyondTap(20, 0)).toBe(true);
    expect(movedBeyondTap(0, 20)).toBe(true);
  });
});

describe("isSlideMounted", () => {
  it("монтируются только активный и соседи", () => {
    expect(isSlideMounted(0, 0)).toBe(true);
    expect(isSlideMounted(1, 0)).toBe(true);
    expect(isSlideMounted(2, 0)).toBe(false);
    expect(isSlideMounted(5, 6)).toBe(true);
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
