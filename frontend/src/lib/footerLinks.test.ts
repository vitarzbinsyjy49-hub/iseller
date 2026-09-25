import { describe, expect, it } from "vitest";
import { footerColumns, FOOTER_SOURCE, type FooterLink } from "./footerLinks";

/** Конфиг, у которого есть ВСЁ: обе ссылки заполнены. */
const FULL = { manager_retail_url: "https://t.me/manager", telegram_channel_url: "https://t.me/shop" };
/** Конфиг недоступен (appConfig отдаёт EMPTY) — все ссылки пустые строки. */
const EMPTY = { manager_retail_url: "", telegram_channel_url: "" };

const allLinks = (config: typeof FULL): FooterLink[] =>
  footerColumns(config).flatMap((c) => c.links);

describe("footerColumns — «Информация»", () => {
  /** Якоря секций Info.tsx переименовывать нельзя: на них ведут кнопки уже
   *  опубликованных постов канала. Именно поэтому их можно назвать здесь, не
   *  заводя второй источник правды — id зафиксированы контрактом, а не вкусом.
   *  Тест ловит обратное: попытку сослаться на раздел, которого нет. */
  it("ведёт только на существующие якоря Info.tsx", () => {
    const info = footerColumns(FULL).find((c) => c.key === "info");
    const routes = info?.links.map((l) => l.action.kind === "route" && l.action.to);
    expect(routes).toEqual([
      "/info#about",
      "/info#delivery",
      "/info#payment",
      "/info#warranty",
      "/info#returns",
      "/info#contacts",
    ]);
  });

  /** Колонка не зависит от конфига: разделы существуют всегда. */
  it("остаётся на месте, когда конфиг недоступен", () => {
    expect(footerColumns(EMPTY).some((c) => c.key === "info")).toBe(true);
  });
});

describe("footerColumns — «Услуги»", () => {
  /** Те же три сценария и те же подписи, что в быстрых действиях сайдбара
   *  главной (HomeSidebar). Разойдутся подписи — один и тот же вход начнёт
   *  называться по-разному на соседних экранах. */
  it("ведут в те же сценарные заявки, что сайдбар главной", () => {
    const services = footerColumns(FULL).find((c) => c.key === "services");
    expect(services?.links.map((l) => [l.label, l.action.kind === "route" && l.action.to])).toEqual([
      ["Опт", "/apply/wholesale"],
      ["Поставка для компании", "/apply/b2b"],
      ["Trade-In", "/apply/trade_in"],
    ]);
  });

  it("сценарий уезжает в payload — иначе по событию не видно, какую услугу открыли", () => {
    const services = footerColumns(FULL).find((c) => c.key === "services");
    expect(services?.links.map((l) => l.payload.scenario)).toEqual(["wholesale", "b2b", "trade_in"]);
  });
});

describe("footerColumns — «Связь»", () => {
  it("показывает обе ссылки, когда обе пришли из конфига", () => {
    const contact = footerColumns(FULL).find((c) => c.key === "contact");
    expect(contact?.links.map((l) => l.key)).toEqual(["manager", "channel"]);
  });

  /** Колонки без настоящего содержимого быть не должно: пустая рубрика
   *  «Связь» выглядит как сломанная вёрстка, а не как отсутствие контакта. */
  it("исчезает целиком, когда конфиг не дал ни одной ссылки", () => {
    expect(footerColumns(EMPTY).some((c) => c.key === "contact")).toBe(false);
  });

  it("остаётся с одной ссылкой, если заполнена только одна", () => {
    const contact = footerColumns({ ...EMPTY, manager_retail_url: "https://t.me/m" })
      .find((c) => c.key === "contact");
    expect(contact?.links.map((l) => l.key)).toEqual(["manager"]);
  });

  /** Ни одного зашитого адреса: всё внешнее приходит из конфига, который
   *  меняется на бэкенде без пересборки витрины. */
  it("внешние ссылки берёт только из конфига", () => {
    const external = allLinks(FULL).filter((l) => l.action.kind === "external");
    expect(external.map((l) => l.action.kind === "external" && l.action.url))
      .toEqual([FULL.manager_retail_url, FULL.telegram_channel_url]);
  });
});

describe("footerColumns — аналитика", () => {
  /** Имена событий живут в allowlist бэкенда (ALLOWED_EVENTS в
   *  backend/app/schemas/ai.py), и незнакомое имя получает 400. Поэтому футер
   *  не заводит своих событий, а переиспользует те, что уже приняты. */
  it("шлёт только имена, которые уже есть в allowlist", () => {
    const known = ["trust_fact_opened", "quick_scenario_clicked", "manager_opened"];
    for (const link of allLinks(FULL)) {
      if (link.event === null) continue;
      expect(known).toContain(link.event);
    }
  });

  /** Подходящего имени для перехода в канал в allowlist нет. Молчать честнее,
   *  чем занять чужое имя: подменённое событие испортит статистику того,
   *  чьё имя мы взяли, и это уже не откатить задним числом. */
  it("не подменяет чужое событие там, где своего нет", () => {
    const channel = allLinks(FULL).find((l) => l.key === "channel");
    expect(channel?.event).toBeNull();
  });

  /** Без source клики из футера сольются с кликами из шапки и сайдбара, и
   *  вопрос «нужен ли футер вообще» останется без ответа. */
  it("каждое событие помечено источником", () => {
    for (const link of allLinks(FULL)) {
      if (link.event === null) continue;
      expect(link.payload.source).toBe(FOOTER_SOURCE);
    }
    expect(FOOTER_SOURCE).toBe("desktop_footer");
  });
});

describe("footerColumns — целостность списка", () => {
  it("ключи ссылок уникальны: по ним React строит список", () => {
    const keys = allLinks(FULL).map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("у каждой ссылки есть непустая подпись", () => {
    for (const link of allLinks(FULL)) expect(link.label.trim().length).toBeGreaterThan(0);
  });

  /** Футер на мобильных не показывается, но и пустым на desktop он быть не
   *  должен: даже при недоступном конфиге остаются разделы и услуги. */
  it("никогда не остаётся без колонок", () => {
    expect(footerColumns(EMPTY).length).toBeGreaterThan(0);
  });
});
