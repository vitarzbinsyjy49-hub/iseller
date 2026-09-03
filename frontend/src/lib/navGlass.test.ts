import { describe, expect, it } from "vitest";
import { hasOpaqueDock, navSurface, OPAQUE_DOCK_SELECTOR } from "./navGlass";

describe("navSurface — три причины отказаться от стекла", () => {
  it("даёт стекло, когда браузер умеет и под панелью ничего не стоит", () => {
    expect(navSurface({ supported: true, dockBehind: false })).toBe("glass");
  });

  it("без backdrop-filter остаётся сплошной: полупрозрачная панель без размытия — мутное окно", () => {
    expect(navSurface({ supported: false, dockBehind: false })).toBe("solid");
  });

  it("под непрозрачной панелью страницы стекла нет: размывать нечего", () => {
    expect(navSurface({ supported: true, dockBehind: true })).toBe("solid");
  });

  it("любая причина по отдельности достаточна", () => {
    expect(navSurface({ supported: false, dockBehind: true })).toBe("solid");
  });

  /** Панель не исчезает и не прячется — меняется только подложка. Это тот же
   *  инвариант, что «убрать движение ≠ убрать событие» в lib/motion.ts. */
  it("другого варианта, кроме glass/solid, не существует", () => {
    const all = [
      navSurface({ supported: true, dockBehind: false }),
      navSurface({ supported: true, dockBehind: true }),
      navSurface({ supported: false, dockBehind: false }),
      navSurface({ supported: false, dockBehind: true }),
    ];
    for (const v of all) expect(["glass", "solid"]).toContain(v);
  });
});

describe("hasOpaqueDock", () => {
  /** Заглушка вместо DOM: тесты проекта идут в node, а от документа здесь
   *  нужен ровно один метод. Запоминает запрошенный селектор, чтобы проверить
   *  не только ответ, но и то, ЧТО именно спрашивали. */
  const stub = (present: string[]) => {
    const asked: string[] = [];
    return {
      asked,
      querySelector(sel: string) {
        asked.push(sel);
        return present.includes(sel) ? {} : null;
      },
    };
  };

  it("находит панель страницы по тому же классу, которым она объявлена", () => {
    expect(hasOpaqueDock(stub([".cta-dock"]))).toBe(true);
  });

  it("на обычной странице панели нет", () => {
    expect(hasOpaqueDock(stub([]))).toBe(false);
  });

  it("спрашивает документ именно про .cta-dock", () => {
    const s = stub([]);
    hasOpaqueDock(s);
    expect(s.asked).toEqual([".cta-dock"]);
  });

  it("без документа (SSR / тест без DOM) отвечает «нет», а не падает", () => {
    expect(hasOpaqueDock(null)).toBe(false);
  });

  it("селектор совпадает с тем, что ищет useRouteTransition", () => {
    expect(OPAQUE_DOCK_SELECTOR).toBe(".cta-dock");
  });
});

