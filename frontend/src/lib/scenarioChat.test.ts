import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./scenario";
import {
  isRequired, looksLikeQuestion, matchChip, needsEscalation, stepsFor,
} from "./scenarioChat";

describe("stepsFor", () => {
  it("все поля сценария + шаг телефона + шаг сводки, в этом порядке", () => {
    const steps = stepsFor(SCENARIOS.trade_in);
    expect(steps).toHaveLength(SCENARIOS.trade_in.fields.length + 2);
    expect(steps[steps.length - 2].kind).toBe("phone");
    expect(steps[steps.length - 1].kind).toBe("summary");
    expect(steps[0]).toMatchObject({ kind: "field", field: { key: "device_type" } });
  });
});

describe("matchChip", () => {
  const condition = SCENARIOS.trade_in.fields.find((f) => f.key === "condition")!;

  it("точное совпадение label", () => {
    expect(matchChip(condition, "Отличное")).toBe("excellent");
  });

  it("совпадение по синониму, регистр и пробелы не важны", () => {
    expect(matchChip(condition, "  ТРЕСНУЛ экран  ")).toBe("damaged");
  });

  it("не находит совпадение — null", () => {
    expect(matchChip(condition, "розовый в крапинку")).toBeNull();
  });

  it("для не-chips полей всегда null", () => {
    const model = SCENARIOS.trade_in.fields.find((f) => f.key === "model")!;
    expect(matchChip(model, "iPhone 15 Pro")).toBeNull();
  });

  it("короткий синоним не матчится как часть другого слова", () => {
    // У "normal" есть синоним "бу" (2 буквы) — подстрочный матчинг случайно
    // совпал бы с любым словом на "бу-" (например «будет»), и свободный текст
    // про гарантию молча уехал бы в «Состояние = Нормальное» вместо эскалации
    // к AI. Матчинг обязан требовать границу слова.
    expect(matchChip(condition, "не знаю, что будет с гарантией")).toBeNull();
    // а сам синоним отдельным словом — по-прежнему матчится
    expect(matchChip(condition, "телефон бу, но работает")).toBe("normal");
  });
});

describe("looksLikeQuestion", () => {
  it("вопросительный знак", () => {
    expect(looksLikeQuestion("а сколько это будет стоить?")).toBe(true);
  });

  it("вопросительное слово без знака", () => {
    expect(looksLikeQuestion("сколько стоит оценка")).toBe(true);
  });

  it("обычный ответ — не вопрос", () => {
    expect(looksLikeQuestion("экран треснул")).toBe(false);
  });
});

describe("needsEscalation", () => {
  const condition = SCENARIOS.trade_in.fields.find((f) => f.key === "condition")!;
  const model = SCENARIOS.trade_in.fields.find((f) => f.key === "model")!;

  it("chips без локального совпадения -> true", () => {
    expect(needsEscalation(condition, "розовый в крапинку")).toBe(true);
  });

  it("chips с локальным совпадением -> false", () => {
    expect(needsEscalation(condition, "треснул")).toBe(false);
  });

  it("свободный текст без вопроса -> false (принимаем как есть)", () => {
    expect(needsEscalation(model, "iPhone 15 Pro")).toBe(false);
  });

  it("похоже на вопрос в свободном тексте -> false (принимаем как есть, не эскалируем)", () => {
    // Продуктовое решение: question-detection применяется только к
    // chips-полям. На text/textarea напечатанный текст никогда не
    // эскалируется — иначе он терялся бы (AI отвечает по FAQ, а исходный
    // текст покупателя никуда не сохраняется).
    expect(needsEscalation(model, "а это точно нужно?")).toBe(false);
  });

  it("похоже на вопрос в chips-поле -> true (эскалация не изменилась)", () => {
    expect(needsEscalation(condition, "а это точно нужно?")).toBe(true);
  });
});

describe("isRequired", () => {
  it("обязательное chips-поле", () => {
    const device = SCENARIOS.trade_in.fields.find((f) => f.key === "device_type")!;
    expect(isRequired(device)).toBe(true);
  });

  it("необязательное text-поле", () => {
    const memory = SCENARIOS.trade_in.fields.find((f) => f.key === "memory")!;
    expect(isRequired(memory)).toBe(false);
  });

  it("textarea всегда необязательна", () => {
    const comment = SCENARIOS.trade_in.fields.find((f) => f.key === "message")!;
    expect(isRequired(comment)).toBe(false);
  });
});
