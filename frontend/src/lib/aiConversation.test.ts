import { describe, expect, it } from "vitest";
import { CONVERSATION_TTL_MS, MAX_STORED_TURNS, fromStored, toStored } from "./aiConversation";
import type { ChatItem, ProductCard } from "../components/ai/types";

function card(id: number): ProductCard {
  return {
    id, title: `Товар ${id}`, brand: "Apple", price: 1000 * id, old_price: null,
    in_stock: true, rating: null, image: "", url: "", why: [], buttons: [],
  };
}

function answer(text: string, cards: ProductCard[] = []): ChatItem {
  return {
    role: "assistant",
    answer: { text, cards, actions: [], meta: { source: "ai", candidates: 8 } },
    elapsed_ms: 4200,
  };
}

const NOW = 1_800_000_000_000;

describe("toStored", () => {
  it("КАРТОЧКИ НЕ СОХРАНЯЮТСЯ — только их id", () => {
    const stored = toStored([answer("Вот варианты", [card(1), card(2)])], null, NOW);
    const turn = stored.turns[0];
    expect(turn).toEqual({
      role: "assistant",
      text: "Вот варианты",
      card_ids: [1, 2],
      elapsed_ms: 4200,
      meta: { source: "ai", candidates: 8 },
    });
    // Ни цены, ни наличия в хранилище быть не должно: это снимок, который
    // завтра соврёт.
    expect(JSON.stringify(stored)).not.toContain("1000");
  });

  it("реплика покупателя сохраняется как есть", () => {
    const stored = toStored([{ role: "user", text: "нужен телефон" }], null, NOW);
    expect(stored.turns[0]).toEqual({ role: "user", text: "нужен телефон" });
  });

  it("помнит товар, с карточки которого пришли", () => {
    expect(toStored([], 42, NOW).focus_id).toBe(42);
  });

  it("хранит только последние ходы: лента не должна расти без предела", () => {
    const many: ChatItem[] = Array.from({ length: MAX_STORED_TURNS + 10 }, (_, i) => ({
      role: "user", text: `вопрос ${i}`,
    }));
    const stored = toStored(many, null, NOW);
    expect(stored.turns).toHaveLength(MAX_STORED_TURNS);
    // Оставляем ХВОСТ: свежие ходы важнее давних.
    expect(stored.turns[stored.turns.length - 1]).toEqual({
      role: "user", text: `вопрос ${MAX_STORED_TURNS + 9}`,
    });
  });

  it("обрезает слишком длинный текст, а не падает на квоте хранилища", () => {
    const huge = "я".repeat(50000);
    const stored = toStored([answer(huge)], null, NOW);
    const turn = stored.turns[0];
    if (turn.role !== "assistant") throw new Error("ожидался ответ");
    expect(turn.text.length).toBeLessThan(huge.length);
  });
});

describe("fromStored", () => {
  it("свежая лента восстанавливается", () => {
    const stored = toStored([{ role: "user", text: "привет" }], 7, NOW);
    const back = fromStored(stored, NOW + 1000);
    expect(back?.turns).toEqual([{ role: "user", text: "привет" }]);
    expect(back?.focus_id).toBe(7);
  });

  it("протухшая лента не восстанавливается: это уже не «продолжить», а мусор", () => {
    const stored = toStored([{ role: "user", text: "привет" }], null, NOW);
    expect(fromStored(stored, NOW + CONVERSATION_TTL_MS + 1)).toBeNull();
  });

  it("ровно на границе срока ещё живёт", () => {
    const stored = toStored([{ role: "user", text: "привет" }], null, NOW);
    expect(fromStored(stored, NOW + CONVERSATION_TTL_MS)).not.toBeNull();
  });

  it("мусор из хранилища не роняет экран", () => {
    expect(fromStored(null, NOW)).toBeNull();
    expect(fromStored("строка", NOW)).toBeNull();
    expect(fromStored(42, NOW)).toBeNull();
    expect(fromStored({}, NOW)).toBeNull();
    expect(fromStored({ saved_at: "вчера", turns: [] }, NOW)).toBeNull();
    expect(fromStored({ saved_at: NOW, turns: "не массив" }, NOW)).toBeNull();
  });

  it("битый ход выбрасывается, остальная лента выживает", () => {
    const back = fromStored({
      saved_at: NOW,
      focus_id: null,
      turns: [
        { role: "user", text: "живой" },
        { role: "нечто" },
        { role: "user" },
        { role: "assistant", text: "тоже живой", card_ids: [1], elapsed_ms: 100, meta: {} },
      ],
    }, NOW);
    expect(back?.turns).toHaveLength(2);
  });

  it("пустая лента — это отсутствие разговора, а не разговор из нуля ходов", () => {
    expect(fromStored({ saved_at: NOW, focus_id: null, turns: [] }, NOW)).toBeNull();
  });

  it("id товаров чистятся от мусора", () => {
    const back = fromStored({
      saved_at: NOW,
      focus_id: null,
      turns: [{ role: "assistant", text: "о", card_ids: [1, "два", -3, 4.5, 7], elapsed_ms: 0, meta: {} }],
    }, NOW);
    const turn = back!.turns[0];
    if (turn.role !== "assistant") throw new Error("ожидался ответ");
    expect(turn.card_ids).toEqual([1, 7]);
  });
});
