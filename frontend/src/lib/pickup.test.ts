import { describe, expect, it } from "vitest";
import {
  PICKUP_ADDRESS,
  PICKUP_CLOSE_HOUR,
  PICKUP_HOURS,
  PICKUP_OPEN_HOUR,
  moscowHour,
  pickupStatus,
} from "./pickup";

describe("строки точки выдачи", () => {
  it("собираются из тех же констант, что и статус — расходиться им негде", () => {
    expect(PICKUP_ADDRESS).toBe("Горбушка, Москва");
    expect(PICKUP_HOURS).toBe(`${PICKUP_OPEN_HOUR}:00–${PICKUP_CLOSE_HOUR}:00`);
  });
});

describe("pickupStatus", () => {
  it("в рабочие часы открыто и подсказывает, до скольких успеть", () => {
    expect(pickupStatus(10)).toEqual({ open: true, label: "до 21:00" });
    expect(pickupStatus(15)).toEqual({ open: true, label: "до 21:00" });
    expect(pickupStatus(20)).toEqual({ open: true, label: "до 21:00" });
  });

  it("час открытия уже рабочий, час закрытия — уже нет", () => {
    // Граница включительна слева и исключительна справа: в 21:00 закрыто.
    expect(pickupStatus(PICKUP_OPEN_HOUR).open).toBe(true);
    expect(pickupStatus(PICKUP_CLOSE_HOUR).open).toBe(false);
  });

  it("вне часов закрыто и подсказывает, с какого часа приходить", () => {
    expect(pickupStatus(9)).toEqual({ open: false, label: "с 10:00" });
    expect(pickupStatus(23)).toEqual({ open: false, label: "с 10:00" });
    expect(pickupStatus(3)).toEqual({ open: false, label: "с 10:00" });
  });
});

describe("moscowHour", () => {
  it("считает московский час, а не местный у покупателя", () => {
    // 06:30 UTC = 09:30 в Москве (UTC+3, без перехода на летнее время)
    expect(moscowHour(new Date("2026-09-07T06:30:00Z"))).toBe(9);
    // 18:00 UTC = 21:00 в Москве — точка уже закрыта
    expect(moscowHour(new Date("2026-09-07T18:00:00Z"))).toBe(21);
  });

  it("переход через полночь по UTC не ломает час", () => {
    // 22:00 UTC = 01:00 следующего дня в Москве
    expect(moscowHour(new Date("2026-09-07T22:00:00Z"))).toBe(1);
  });

  it("зимой смещение то же: перехода на летнее время в России нет", () => {
    expect(moscowHour(new Date("2026-01-15T06:30:00Z"))).toBe(9);
  });

  it("сцепка с pickupStatus даёт закрыто ночью и открыто днём по Москве", () => {
    expect(pickupStatus(moscowHour(new Date("2026-09-07T22:00:00Z"))).open).toBe(false);
    expect(pickupStatus(moscowHour(new Date("2026-09-07T09:00:00Z"))).open).toBe(true);
  });
});
