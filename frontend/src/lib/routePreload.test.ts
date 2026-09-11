import { describe, expect, it } from "vitest";
import { WARM_DATA } from "./routePreload";
import { SHOP } from "./apiCache";

/** Прогрев данных держится на совпадении строки запроса символ в символ: ключ
 *  кэша — это сам путь. Разойдись прогрев с экраном — обе стороны продолжат
 *  честно работать, просто ускорения не будет, и по коду этого не увидеть.
 *  Единственная защита — общие литералы SHOP; тест стережёт именно их. */
describe("прогрев данных экрана", () => {
  it("греются только пути из общего списка витрины", () => {
    const known = new Set<string>(Object.values(SHOP));
    for (const paths of Object.values(WARM_DATA)) {
      for (const path of paths) expect(known.has(path)).toBe(true);
    }
  });

  it("пути абсолютные и без повторов", () => {
    for (const paths of Object.values(WARM_DATA)) {
      expect(paths.every((p) => p.startsWith("/"))).toBe(true);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it("личное не греется и не кэшируется", () => {
    // Корзина, избранное, «для вас» меняются от действий самого человека:
    // показать их из кэша значит показать неправду сразу после нажатия.
    const all = Object.values(WARM_DATA).flat();
    for (const personal of ["/cart", "/favorites", "/users/me", "/catalog/recommendations"]) {
      expect(all.some((p) => p.startsWith(personal))).toBe(false);
    }
  });

  it("у главной греется и лента, и плитки — без них экрана нет", () => {
    expect(WARM_DATA.home).toContain(SHOP.feed);
    expect(WARM_DATA.home).toContain(SHOP.home);
  });
});
