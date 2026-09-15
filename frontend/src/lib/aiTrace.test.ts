import { describe, expect, it } from "vitest";
import { formatElapsed, runningLabel, traceText } from "./aiTrace";

describe("runningLabel", () => {
  it("пороги ожидания достались от прежней подписи и не меняются", () => {
    expect(runningLabel(0)).toBe("Ищу в каталоге");
    expect(runningLabel(3999)).toBe("Ищу в каталоге");
    expect(runningLabel(4000)).toBe("Подбираю варианты");
    expect(runningLabel(15999)).toBe("Подбираю варианты");
    expect(runningLabel(16000)).toBe("Сверяю наличие и цену");
    expect(runningLabel(70000)).toBe("Сверяю наличие и цену");
  });
});

describe("formatElapsed", () => {
  it("до секунды — один знак после запятой, с русской запятой", () => {
    expect(formatElapsed(300)).toBe("0,3 с");
    expect(formatElapsed(700)).toBe("0,7 с");
  });

  it("не показывает «0 с»: любое ожидание длилось хотя бы десятую", () => {
    expect(formatElapsed(20)).toBe("0,1 с");
    expect(formatElapsed(0)).toBe("0,1 с");
  });

  it("не показывает «1,0 с» — это целая секунда", () => {
    expect(formatElapsed(950)).toBe("1 с");
  });

  it("от секунды — целые", () => {
    expect(formatElapsed(4400)).toBe("4 с");
    expect(formatElapsed(15600)).toBe("16 с");
  });

  it("от минуты — словами: таймаут фронта 75с, и «75 с» читается хуже", () => {
    expect(formatElapsed(60000)).toBe("больше минуты");
    expect(formatElapsed(75000)).toBe("больше минуты");
    // округление вверх до 60 — тоже «больше минуты», а не «60 с»
    expect(formatElapsed(59600)).toBe("больше минуты");
    expect(formatElapsed(59000)).toBe("59 с");
  });

  it("мусор вместо числа не роняет строку", () => {
    expect(formatElapsed(Number.NaN)).toBe("0,1 с");
    expect(formatElapsed(-500)).toBe("0,1 с");
  });
});

describe("traceText", () => {
  it("детерминированный ответ следа не оставляет — показывать нечего", () => {
    expect(traceText({ source: "rules" }, 40)).toBeNull();
  });

  it("быстрый путь по каталогу опознаётся по флагу, а не по source", () => {
    // backend кладёт в source строку "catalog", которой нет в союзе типа;
    // ориентир — сам флаг
    expect(traceText({ skipped_llm: true }, 300)).toBe("Нашёл в каталоге · 0,3 с");
  });

  it("деградация важнее source: backend ставит оба признака разом", () => {
    expect(traceText({ source: "fallback", degraded: true }, 5000))
      .toBe("Упрощённый режим, подобрал из каталога · 5 с");
  });

  it("фронтовый fallback — без деградации, но и без модели", () => {
    expect(traceText({ source: "fallback" }, 6000)).toBe("Ответил из каталога · 6 с");
  });

  it("кэш и демо-режим называют себя сами", () => {
    expect(traceText({ source: "cache" }, 200)).toBe("Взял недавний ответ · 0,2 с");
    expect(traceText({ source: "mock" }, 400)).toBe("Демо-режим · 0,4 с");
  });

  it("ответ модели показывает, сколько позиций она просмотрела", () => {
    expect(traceText({ source: "ai", candidates: 12 }, 4400))
      .toBe("Просмотрел 12 позиций каталога · 4 с");
  });

  it("«каталога», а не «в наличии»: склад фильтруется не всегда", () => {
    expect(traceText({ source: "ai", candidates: 3 }, 4000)).not.toContain("наличии");
  });

  it("склоняет «позицию» по правилам русского языка", () => {
    expect(traceText({ source: "ai", candidates: 1 }, 1000)).toContain("1 позицию");
    expect(traceText({ source: "ai", candidates: 2 }, 1000)).toContain("2 позиции");
    expect(traceText({ source: "ai", candidates: 4 }, 1000)).toContain("4 позиции");
    expect(traceText({ source: "ai", candidates: 5 }, 1000)).toContain("5 позиций");
    expect(traceText({ source: "ai", candidates: 11 }, 1000)).toContain("11 позиций");
    expect(traceText({ source: "ai", candidates: 21 }, 1000)).toContain("21 позицию");
    expect(traceText({ source: "ai", candidates: 22 }, 1000)).toContain("22 позиции");
  });

  it("ноль кандидатов — это не «просмотрел 0 позиций», а общая строка", () => {
    expect(traceText({ source: "ai", candidates: 0 }, 4000)).toBe("Подобрал варианты · 4 с");
  });

  it("неполная meta не роняет строку — backend может вернуть что угодно", () => {
    expect(traceText({}, 4000)).toBe("Подобрал варианты · 4 с");
    expect(traceText(undefined, 4000)).toBe("Подобрал варианты · 4 с");
    expect(traceText({ source: "ai" }, 4000)).toBe("Подобрал варианты · 4 с");
  });
});
