import { describe, expect, it } from "vitest";
import { bugContext, canSendBugReport } from "./bugReport";

describe("bugContext — что приложить к сообщению об ошибке", () => {
  it("в Telegram на телефоне — всё, по чему воспроизводят", () => {
    expect(bugContext({
      window: { innerWidth: 390.4, innerHeight: 844 },
      navigator: { userAgent: "Mozilla/5.0 (iPhone)" },
      telegram: { platform: "ios", version: "8.0" },
    })).toEqual({ platform: "ios", tg_version: "8.0", viewport: "390x844", user_agent: "Mozilla/5.0 (iPhone)" });
  });

  it("вне Telegram и без окна — пустые поля не выдумываются", () => {
    expect(bugContext({ window: null, navigator: null, telegram: null })).toEqual({});
    // Свёрнутое окно отдаёт 0 — размер «0x0» только сбил бы с толку.
    expect(bugContext({ window: { innerWidth: 0, innerHeight: 0 }, navigator: {}, telegram: {} })).toEqual({});
  });
});

describe("canSendBugReport", () => {
  it("нужно хотя бы пару слов и не во время загрузки", () => {
    expect(canSendBugReport("ой", false)).toBe(false);
    expect(canSendBugReport("   не работает   ", false)).toBe(true);
    expect(canSendBugReport("не работает", true)).toBe(false);
  });
});
