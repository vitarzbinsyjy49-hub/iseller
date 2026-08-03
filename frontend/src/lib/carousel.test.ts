import { describe, expect, it } from "vitest";
import {
  AUTOPLAY_RESUME_MS,
  autoplayReady,
  indexFromScroll,
  isSlideMounted,
  isTapGesture,
  nextSlideIndex,
  slideTransition,
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

describe("nextSlideIndex", () => {
  it("идёт вперёд по одному", () => {
    expect(nextSlideIndex(0, 5)).toBe(1);
    expect(nextSlideIndex(3, 5)).toBe(4);
  });
  it("с последнего возвращается на первый — лента бесконечная", () => {
    expect(nextSlideIndex(4, 5)).toBe(0);
  });
  it("один слайд или пустая лента — двигаться некуда", () => {
    expect(nextSlideIndex(0, 1)).toBe(0);
    expect(nextSlideIndex(0, 0)).toBe(0);
  });
});

describe("autoplayReady", () => {
  const t = 100_000;
  it("листает, когда никто не трогал ленту", () => {
    expect(autoplayReady({ now: t, lastInteractionAt: 0, visible: true, scrollable: true })).toBe(true);
  });
  it("молчит сразу после жеста и оживает по истечении паузы", () => {
    expect(autoplayReady({ now: t, lastInteractionAt: t - 1_000, visible: true, scrollable: true })).toBe(false);
    expect(autoplayReady({
      now: t, lastInteractionAt: t - AUTOPLAY_RESUME_MS - 1, visible: true, scrollable: true,
    })).toBe(true);
  });
  it("вкладка скрыта — не листаем: иначе на возврате лента прыгает", () => {
    expect(autoplayReady({ now: t, lastInteractionAt: 0, visible: false, scrollable: true })).toBe(false);
  });
  it("лента не скроллится (desktop-сетка, один баннер) — автоплей выключен", () => {
    expect(autoplayReady({ now: t, lastInteractionAt: 0, visible: true, scrollable: false })).toBe(false);
  });
});

describe("slideTransition", () => {
  it("обычный режим — лента едет", () => {
    expect(slideTransition(false)).toBe("slide");
  });
  it("«уменьшить движение» — затухание вместо движения", () => {
    expect(slideTransition(true)).toBe("fade");
  });
  it("перехода нет только у самого перехода: варианта «мгновенно» не бывает", () => {
    // Подмена баннера без всякого перехода читалась как сбой отрисовки:
    // человек не понимал, что лента листается сама.
    expect([slideTransition(true), slideTransition(false)]).not.toContain("none");
  });
});
