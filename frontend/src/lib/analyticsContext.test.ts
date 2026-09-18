import { describe, expect, it } from "vitest";
import { eventContext, viewportBucket } from "./analyticsContext";

/** Границы бакетов обязаны совпадать с брейкпоинтами, по которым раскладка
 *  реально переключается: 768 и 1024 — `md` и `lg` у Tailwind, 1440 — свой
 *  `wide` из tailwind.config.js. Поэтому проверяем каждую границу парой
 *  значений «за шаг до» и «ровно на»: именно здесь такие функции ошибаются на
 *  единицу, и именно эта ошибка сдвинула бы отчёт на целый класс устройств. */
describe("viewportBucket — ширина окна в бакет раскладки", () => {
  it("телефон и узкое окно Mini App — xs", () => {
    expect(viewportBucket(360)).toBe("xs");
    expect(viewportBucket(767)).toBe("xs");
  });

  it("с 768 начинается sm, и это ещё НЕ десктоп-раскладка", () => {
    expect(viewportBucket(768)).toBe("sm");
    expect(viewportBucket(1023)).toBe("sm");
  });

  it("с 1024 включается lg-слой Tailwind — это md", () => {
    expect(viewportBucket(1024)).toBe("md");
    expect(viewportBucket(1439)).toBe("md");
  });

  it("с 1440 включается собственный брейкпоинт wide — это lg", () => {
    expect(viewportBucket(1440)).toBe("lg");
    expect(viewportBucket(2560)).toBe("lg");
  });

  /** Аналитика не имеет права ломать интерфейс — это правило записано прямо в
   *  docstring модуля analytics.ts. Ширина 0 приходит от свёрнутого окна и от
   *  вкладки в фоне; падать на ней нельзя. */
  it("нулевая и отрицательная ширина отдают xs, а не падают", () => {
    expect(viewportBucket(0)).toBe("xs");
    expect(viewportBucket(-1)).toBe("xs");
  });
});

describe("eventContext — служебные поля события", () => {
  /** Тесты этого проекта идут в node без DOM. Без window контекст обязан быть
   *  пустым и молчаливым: иначе первый же тест, дёрнувший track(), упал бы. */
  it("без window отдаёт пустой контекст", () => {
    expect(eventContext({ window: null, telegram: null })).toEqual({
      viewport: null,
      platform: null,
    });
  });

  it("берёт ширину из окна и платформу из Telegram", () => {
    expect(
      eventContext({ window: { innerWidth: 1280 }, telegram: { platform: "tdesktop" } }),
    ).toEqual({ viewport: "md", platform: "tdesktop" });
  });

  /** Локальная разработка в браузере: окно есть, Telegram нет. Ширину всё
   *  равно меряем — иначе локальные прогоны выпадали бы из статистики
   *  раскладок без всякой причины. */
  it("вне Telegram ширину пишет, платформу оставляет пустой", () => {
    expect(eventContext({ window: { innerWidth: 390 }, telegram: null })).toEqual({
      viewport: "xs",
      platform: null,
    });
  });

  /** Telegram отдаёт platform не всегда (старые клиенты, веб-версии). Поле
   *  необязательное, и его отсутствие не должно превращаться в строку
   *  "undefined" в базе. */
  it("Telegram без поля platform не создаёт мусорного значения", () => {
    expect(eventContext({ window: { innerWidth: 1440 }, telegram: {} })).toEqual({
      viewport: "lg",
      platform: null,
    });
  });
});
