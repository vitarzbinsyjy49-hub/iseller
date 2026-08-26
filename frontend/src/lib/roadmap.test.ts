import { describe, expect, it } from "vitest";
import { PERIOD_ORDER, ROADMAP, roadmapFor, type RoadmapTrack } from "./roadmap";

const TRACKS: RoadmapTrack[] = ["app", "ai", "loyalty"];

describe("ROADMAP", () => {
  it("id уникальны — иначе React склеит пункты по key", () => {
    const ids = ROADMAP.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("у каждого пункта есть экран: пункт без трека не виден нигде", () => {
    for (const item of ROADMAP) {
      expect(item.tracks.length, item.id).toBeGreaterThan(0);
    }
  });

  it("не обещает онлайн-оплату", () => {
    // Магазин работает по договору комиссии, сделка идёт очно (AboutServiceSheet).
    // Пункт про оплату картой обещал бы смену юридической модели.
    const text = ROADMAP.map((i) => `${i.title} ${i.body}`).join(" ").toLowerCase();
    expect(text).not.toMatch(/оплат[аиуы]? картой|онлайн-оплат|сбп/);
  });
});

describe("roadmapFor", () => {
  it("на каждом экране есть что показать", () => {
    for (const track of TRACKS) {
      expect(roadmapFor(track).length, track).toBeGreaterThan(0);
    }
  });

  it("группы идут в порядке периодов и не бывают пустыми", () => {
    for (const track of TRACKS) {
      const groups = roadmapFor(track);
      const order = groups.map((g) => PERIOD_ORDER.indexOf(g.period));
      expect([...order], track).toEqual([...order].sort((a, b) => a - b));
      for (const group of groups) expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("пункт попадает только на свои экраны", () => {
    for (const track of TRACKS) {
      for (const group of roadmapFor(track)) {
        for (const item of group.items) {
          expect(item.tracks, `${item.id} на экране ${track}`).toContain(track);
        }
      }
    }
  });

  it("сентябрь обещан и его видно с каждого экрана", () => {
    for (const track of TRACKS) {
      expect(roadmapFor(track)[0].period, track).toBe("sep");
    }
  });
});
