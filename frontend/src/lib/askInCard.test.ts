import { describe, expect, it } from "vitest";
import type { AiAnswer, ProductCard } from "../components/ai/types";
import {
  ASK_INITIAL,
  ASK_MAX_CARDS,
  ASK_MAX_LEN,
  ASK_PRESETS,
  aiChatHref,
  aiSeesProduct,
  askCardsRow,
  askFailureOf,
  askReducer,
  buildAskBody,
  showAskInCard,
  type AskState,
} from "./askInCard";

const answer = (text = "Ответ"): AiAnswer => ({ text, cards: [], actions: [], meta: {} });
const card = (id: number) => ({ id }) as ProductCard;

describe("ASK_PRESETS", () => {
  it("ровно три вопроса из спеки, в её порядке", () => {
    expect([...ASK_PRESETS]).toEqual([
      "Чем отличается от прошлой модели?",
      "Что есть новее или похожее?",
      "Кому подойдёт?",
    ]);
  });
});

describe("buildAskBody", () => {
  it("несёт id товара и ПУСТУЮ историю — вопрос из карточки всегда первый ход", () => {
    expect(buildAskBody(42, "Кому подойдёт?")).toEqual({
      message: "Кому подойдёт?", history: [], product_id: 42,
    });
  });

  it("обрезает пробелы по краям", () => {
    expect(buildAskBody(1, "  влезет в ручную кладь?  ")?.message).toBe("влезет в ручную кладь?");
  });

  it("пустой и пробельный вопрос не уходит вовсе", () => {
    expect(buildAskBody(1, "")).toBeNull();
    expect(buildAskBody(1, "   \n ")).toBeNull();
  });

  it("длиннее лимита backend — режется, а не отвергается 422-й", () => {
    const body = buildAskBody(1, "а".repeat(ASK_MAX_LEN + 50));
    expect(body?.message.length).toBe(ASK_MAX_LEN);
  });
});

describe("askFailureOf", () => {
  it("429 — лимит, просим подождать", () => {
    expect(askFailureOf({ status: 429 })).toBe("rate_limit");
  });

  it("прочие статусы, сеть и таймаут — общий сбой", () => {
    expect(askFailureOf({ status: 500 })).toBe("failed");
    expect(askFailureOf(new TypeError("Failed to fetch"))).toBe("failed");
    expect(askFailureOf(new DOMException("aborted", "AbortError"))).toBe("failed");
    expect(askFailureOf(null)).toBe("failed");
    expect(askFailureOf(undefined)).toBe("failed");
  });
});

describe("askReducer", () => {
  const ask = (seq: number, question = "Кому подойдёт?") =>
    ({ type: "ask", seq, question, kind: "preset", startedAt: 100 }) as const;

  it("вопрос -> загрузка -> ответ", () => {
    let s: AskState = askReducer(ASK_INITIAL, ask(1));
    expect(s.status).toBe("loading");
    s = askReducer(s, { type: "answer", seq: 1, answer: answer("Да"), elapsedMs: 900 });
    expect(s).toMatchObject({ status: "done", question: "Кому подойдёт?", kind: "preset", elapsedMs: 900 });
    expect(s.status === "done" && s.answer.text).toBe("Да");
  });

  it("отказ сохраняет вопрос — по нему работает «Попробовать ещё раз»", () => {
    let s = askReducer(ASK_INITIAL, { ...ask(1, "своё"), kind: "custom" });
    s = askReducer(s, { type: "fail", seq: 1, failure: "rate_limit" });
    expect(s).toMatchObject({ status: "error", question: "своё", kind: "custom", failure: "rate_limit" });
  });

  it("ответ на прежний вопрос, пришедший после нового, отбрасывается", () => {
    let s = askReducer(ASK_INITIAL, ask(1, "первый"));
    s = askReducer(s, ask(2, "второй"));
    const late = askReducer(s, { type: "answer", seq: 1, answer: answer("про первый"), elapsedMs: 1 });
    expect(late).toBe(s);
    const fresh = askReducer(s, { type: "answer", seq: 2, answer: answer("про второй"), elapsedMs: 1 });
    expect(fresh).toMatchObject({ status: "done", question: "второй" });
  });

  it("ответ без текущей загрузки ничего не меняет", () => {
    expect(askReducer(ASK_INITIAL, { type: "answer", seq: 0, answer: answer(), elapsedMs: 1 })).toBe(ASK_INITIAL);
    expect(askReducer(ASK_INITIAL, { type: "fail", seq: 0, failure: "failed" })).toBe(ASK_INITIAL);
  });

  it("повторный вопрос после ответа снова уходит в загрузку", () => {
    let s = askReducer(ASK_INITIAL, ask(1));
    s = askReducer(s, { type: "answer", seq: 1, answer: answer(), elapsedMs: 1 });
    s = askReducer(s, ask(2, "ещё"));
    expect(s).toMatchObject({ status: "loading", seq: 2, question: "ещё" });
  });
});

describe("askCardsRow", () => {
  it("убирает сам открытый товар", () => {
    expect(askCardsRow([card(7), card(8), card(9)], 7).map((c) => c.id)).toEqual([8, 9]);
  });

  it("держит не больше потолка", () => {
    const cards = Array.from({ length: 10 }, (_, i) => card(i + 100));
    expect(askCardsRow(cards, 1)).toHaveLength(ASK_MAX_CARDS);
  });

  it("пусто — пусто", () => {
    expect(askCardsRow([], 1)).toEqual([]);
  });
});

describe("видимость блока", () => {
  it("обычный товар — блок есть", () => {
    expect(showAskInCard({ availability_mode: "in_stock" })).toBe(true);
    expect(showAskInCard({})).toBe(true);
  });

  it("легендарный — нет: у него свой экран и своя кнопка", () => {
    expect(showAskInCard({ is_legendary: true, availability_mode: "in_stock" })).toBe(false);
  });

  it("предзаказ — нет: AI его не видит", () => {
    expect(showAskInCard({ availability_mode: "preorder" })).toBe(false);
    expect(aiSeesProduct({ availability_mode: "preorder" })).toBe(false);
  });

  it("цену называть нельзя — тоже предзаказ, даже без режима в ответе API", () => {
    expect(aiSeesProduct({ price_note: "Цена по запросу" })).toBe(false);
    expect(showAskInCard({ price_note: "Цена по запросу" })).toBe(false);
  });

  it("под заказ и нет в наличии AI видит — блок остаётся", () => {
    expect(showAskInCard({ availability_mode: "on_request" })).toBe(true);
    expect(showAskInCard({ availability_mode: "out_of_stock" })).toBe(true);
  });
});

describe("aiChatHref", () => {
  it("ровно тот параметр, который читает AiSearch", () => {
    expect(aiChatHref(42)).toBe("/ai?product=42");
  });
});
