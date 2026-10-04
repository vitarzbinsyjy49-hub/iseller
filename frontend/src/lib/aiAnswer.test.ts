import { describe, expect, it } from "vitest";
import { EMPTY_ANSWER_TEXT, normalizeAnswer } from "./aiAnswer";
import type { AiAnswer } from "../components/ai/types";

describe("normalizeAnswer", () => {
  it("полный ответ проходит как есть", () => {
    const raw: AiAnswer = { text: "Да", cards: [], actions: [], meta: { source: "ai" } };
    expect(normalizeAnswer(raw)).toEqual(raw);
  });

  it("пустой или отсутствующий ответ не роняет экран", () => {
    for (const raw of [null, undefined, {}]) {
      expect(normalizeAnswer(raw)).toEqual({ text: EMPTY_ANSWER_TEXT, cards: [], actions: [], meta: {} });
    }
  });

  it("мусор вместо полей заменяется пустыми значениями", () => {
    const raw = { text: 42, cards: "нет", actions: null, meta: "x" } as unknown as Partial<AiAnswer>;
    expect(normalizeAnswer(raw)).toEqual({ text: EMPTY_ANSWER_TEXT, cards: [], actions: [], meta: {} });
  });
});
