import { describe, expect, it, vi } from "vitest";
import { applyTelegramColors, startParamFrom } from "./telegram";

describe("applyTelegramColors", () => {
  it("вызывает все три сеттера с переданными цветами, когда они есть", () => {
    const tg = {
      setHeaderColor: vi.fn(),
      setBackgroundColor: vi.fn(),
      setBottomBarColor: vi.fn(),
    };
    applyTelegramColors(tg, { header: "#14304d", background: "#f6f7f9", bottomBar: "#ffffff" });
    expect(tg.setHeaderColor).toHaveBeenCalledWith("#14304d");
    expect(tg.setBackgroundColor).toHaveBeenCalledWith("#f6f7f9");
    expect(tg.setBottomBarColor).toHaveBeenCalledWith("#ffffff");
  });

  it("не падает, если методов нет (старый клиент Telegram)", () => {
    expect(() =>
      applyTelegramColors({}, { header: "#14304d", background: "#f6f7f9", bottomBar: "#ffffff" }),
    ).not.toThrow();
  });

  it("не пробрасывает исключение сеттера и всё равно вызывает следующие", () => {
    const tg = {
      setHeaderColor: () => {
        throw new Error("unsupported on old client");
      },
      setBackgroundColor: vi.fn(),
      setBottomBarColor: vi.fn(),
    };
    expect(() =>
      applyTelegramColors(tg, { header: "#14304d", background: "#f6f7f9", bottomBar: "#ffffff" }),
    ).not.toThrow();
    expect(tg.setBackgroundColor).toHaveBeenCalledWith("#f6f7f9");
    expect(tg.setBottomBarColor).toHaveBeenCalledWith("#ffffff");
  });
});

describe("startParamFrom", () => {
  it("возвращает start_param, когда запуск был по ?startapp=", () => {
    expect(startParamFrom({ initDataUnsafe: { start_param: "price_iphone" } })).toBe("price_iphone");
  });
  it("null — обычный запуск (нет initDataUnsafe/start_param/вне Telegram)", () => {
    expect(startParamFrom(null)).toBeNull();
    expect(startParamFrom({})).toBeNull();
    expect(startParamFrom({ initDataUnsafe: {} })).toBeNull();
    expect(startParamFrom({ initDataUnsafe: { start_param: "" } })).toBeNull();
    expect(startParamFrom({ initDataUnsafe: { start_param: "   " } })).toBeNull();
  });
});
