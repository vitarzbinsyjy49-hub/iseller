import { describe, expect, it } from "vitest";
import { shouldSkipMotion } from "./gsapMotion";

describe("shouldSkipMotion", () => {
  it("играет движение в обычных условиях", () => {
    expect(shouldSkipMotion(false, false)).toBe(false);
  });

  it("снимает движение при «уменьшить движение»", () => {
    expect(shouldSkipMotion(true, false)).toBe(true);
  });

  it("снимает движение в СКРЫТОЙ вкладке: там rAF не идёт вовсе, и анимация не завершилась бы никогда", () => {
    expect(shouldSkipMotion(false, true)).toBe(true);
  });

  it("достаточно любой из причин", () => {
    expect(shouldSkipMotion(true, true)).toBe(true);
  });
});
