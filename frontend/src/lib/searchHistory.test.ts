import { describe, expect, it } from "vitest";
import { addToHistory, aiEntryAction, HISTORY_LIMIT } from "./searchHistory";

describe("addToHistory", () => {
  it("добавляет запрос в начало списка", () => {
    expect(addToHistory(["macbook"], "iphone 15")).toEqual(["iphone 15", "macbook"]);
  });

  it("тримит и не сохраняет пустое/односимвольное", () => {
    expect(addToHistory([], "   ")).toEqual([]);
    expect(addToHistory([], "a")).toEqual([]);
    expect(addToHistory([], "  ps5  ")).toEqual(["ps5"]);
  });

  it("дедуплицирует без учёта регистра, поднимая свежий вариант наверх", () => {
    expect(addToHistory(["iPhone", "ps5"], "IPHONE")).toEqual(["IPHONE", "ps5"]);
  });

  it("ограничивает список HISTORY_LIMIT записями", () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => `query ${i}`);
    const next = addToHistory(full, "новый запрос");
    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[0]).toBe("новый запрос");
    expect(next).not.toContain(`query ${HISTORY_LIMIT - 1}`);
  });

  it("обрезает слишком длинный запрос, а не отбрасывает его", () => {
    const long = "x".repeat(200);
    const [saved] = addToHistory([], long);
    expect(saved.length).toBeLessThanOrEqual(80);
  });
});

describe("aiEntryAction (/ai?q=…&auto=1)", () => {
  it("без q — ничего не делаем", () => {
    expect(aiEntryAction(null, false, false)).toBe("none");
    expect(aiEntryAction("   ", true, false)).toBe("none");
  });

  it("q без auto — только prefill, БЕЗ отправки", () => {
    expect(aiEntryAction("iphone до 90000", false, false)).toBe("prefill");
  });

  it("q с auto=1 — одна контролируемая отправка", () => {
    expect(aiEntryAction("iphone до 90000", true, false)).toBe("submit");
  });

  it("повторный вызов (StrictMode/remount) не отправляет второй раз", () => {
    expect(aiEntryAction("iphone до 90000", true, true)).toBe("none");
    expect(aiEntryAction("iphone до 90000", false, true)).toBe("none");
  });
});
