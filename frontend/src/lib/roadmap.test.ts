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

describe("выполненные пункты", () => {
  it("рефералка отмечена сделанной — она выехала на прод 07.09.2026", () => {
    const item = ROADMAP.find((i) => i.id === "referral");
    expect(item?.done, "пункт про приглашения").toBe(true);
  });

  it("сделанное идёт первым в своей группе", () => {
    // Список должен доказывать, что роудмап живой: галочка наверху читается
    // как «обещанное выходит», а закопанная в середину — как случайность.
    for (const track of TRACKS) {
      for (const group of roadmapFor(track)) {
        const flags = group.items.map((i) => (i.done ? 0 : 1));
        expect([...flags], `${track}/${group.period}`).toEqual([...flags].sort());
      }
    }
  });

  it("сделанное не выпадает из своего периода", () => {
    // Соблазн переложить выполненное в отдельную группу «Готово» есть, но
    // тогда пропадает главное: обещали на сентябрь — и сделали в сентябре.
    const referral = ROADMAP.find((i) => i.id === "referral");
    expect(referral?.period).toBe("sep");
    const groups = roadmapFor("loyalty");
    expect(groups[0].items.some((i) => i.id === "referral")).toBe(true);
  });

  it("порядок внутри группы стабилен: сортировка не тасует равные пункты", () => {
    const first = roadmapFor("app").map((g) => g.items.map((i) => i.id));
    const second = roadmapFor("app").map((g) => g.items.map((i) => i.id));
    expect(first).toEqual(second);
  });
});
