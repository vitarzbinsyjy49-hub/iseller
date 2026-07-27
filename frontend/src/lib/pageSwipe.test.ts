import { describe, expect, it } from "vitest";
import {
  SWIPE_TABS,
  classifyPageSwipe,
  enterAnimationFor,
  resolveSwipeNav,
  tabIndexOf,
} from "./pageSwipe";

describe("tabIndexOf", () => {
  it("узнаёт корневые вкладки", () => {
    expect(tabIndexOf("/")).toBe(0);
    expect(tabIndexOf("/catalog")).toBe(1);
    expect(tabIndexOf("/profile")).toBe(4);
  });
  it("вкладка с параметрами запроса и вложенным путём — та же вкладка", () => {
    expect(tabIndexOf("/catalog/apple")).toBe(1);
  });
  it("вложенные экраны вкладками не считаются", () => {
    expect(tabIndexOf("/product/42")).toBe(-1);
    expect(tabIndexOf("/favorites")).toBe(-1);
    expect(tabIndexOf("/history")).toBe(-1);
  });
  it("«/» не матчит всё подряд по префиксу", () => {
    expect(tabIndexOf("/product/1")).not.toBe(0);
  });
});

describe("resolveSwipeNav — вкладки", () => {
  it("палец влево ведёт к следующей вкладке, вправо — к предыдущей", () => {
    expect(resolveSwipeNav("/catalog", "left", false)).toEqual({ kind: "tab", to: "/ai" });
    expect(resolveSwipeNav("/catalog", "right", false)).toEqual({ kind: "tab", to: "/" });
  });
  it("на краях списка не зацикливается", () => {
    expect(resolveSwipeNav("/", "right", false)).toBeNull();
    expect(resolveSwipeNav(SWIPE_TABS[SWIPE_TABS.length - 1], "left", false)).toBeNull();
  });
  it("на вкладке жест ловится из любого места, не только от края", () => {
    expect(resolveSwipeNav("/ai", "right", false)).toEqual({ kind: "tab", to: "/catalog" });
  });
});

describe("resolveSwipeNav — вложенные экраны", () => {
  it("свайп вправо от левого края возвращает назад", () => {
    expect(resolveSwipeNav("/product/42", "right", true)).toEqual({ kind: "back" });
  });
  it("тот же свайп из середины экрана игнорируется (там горизонтальный контент)", () => {
    expect(resolveSwipeNav("/product/42", "right", false)).toBeNull();
  });
  it("свайп влево на вложенном экране никуда не ведёт", () => {
    expect(resolveSwipeNav("/product/42", "left", true)).toBeNull();
  });
});

describe("classifyPageSwipe", () => {
  const W = 400;
  it("уверенный горизонтальный размах — листание", () => {
    expect(classifyPageSwipe(-140, 10, W, 400)).toBe("left");
    expect(classifyPageSwipe(140, 10, W, 400)).toBe("right");
  });
  it("вертикальный жест — это скролл страницы, не листание", () => {
    expect(classifyPageSwipe(30, 200, W, 400)).toBeNull();
    expect(classifyPageSwipe(120, 100, W, 400)).toBeNull();
  });
  it("вялый горизонтальный сдвиг ниже порога не листает", () => {
    expect(classifyPageSwipe(-50, 4, W, 600)).toBeNull();
  });
  it("быстрый флик засчитывается по меньшему размаху", () => {
    expect(classifyPageSwipe(-50, 4, W, 120)).toBe("left");
    expect(classifyPageSwipe(-30, 4, W, 120)).toBeNull();   // слишком короткий даже для флика
  });
  it("порог растёт вместе с шириной экрана", () => {
    expect(classifyPageSwipe(-100, 4, 1000, 600)).toBeNull();  // 25% от 1000 = 250
    expect(classifyPageSwipe(-300, 4, 1000, 600)).toBe("left");
  });
});

describe("enterAnimationFor", () => {
  it("следующая страница въезжает с той стороны, откуда её «тянут»", () => {
    expect(enterAnimationFor("left")).toBe("from-right");
    expect(enterAnimationFor("right")).toBe("from-left");
  });
});
