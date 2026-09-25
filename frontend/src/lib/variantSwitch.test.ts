import { describe, expect, it } from "vitest";
import { isVariantSwitch, variantSwitchState } from "./variantSwitch";

describe("variantSwitch", () => {
  it("узнаёт переход между вариантами по state навигации", () => {
    expect(isVariantSwitch(variantSwitchState())).toBe(true);
  });

  it("обычный переход — не смена варианта", () => {
    // location.state у обычной навигации null; у чужих state — посторонние поля.
    expect(isVariantSwitch(null)).toBe(false);
    expect(isVariantSwitch(undefined)).toBe(false);
    expect(isVariantSwitch({ from: "catalog" })).toBe(false);
    expect(isVariantSwitch("variantSwitch")).toBe(false);
  });
});
