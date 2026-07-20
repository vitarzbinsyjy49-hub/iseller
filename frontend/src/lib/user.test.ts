import { describe, expect, it } from "vitest";
import { initials, displayName } from "./user";

describe("initials", () => {
  it("uses first+last name initials when both are present", () => {
    expect(initials("Иван", "Петров")).toBe("ИП");
  });

  it("falls back to first two letters of first name", () => {
    expect(initials("Anna", null)).toBe("AN");
  });

  it("falls back to username when no name is set", () => {
    expect(initials(null, null, "dev_user")).toBe("DE");
  });

  it("falls back to a placeholder when nothing is known", () => {
    expect(initials(null, null, null)).toBe("?");
  });
});

describe("displayName", () => {
  it("joins first and last name", () => {
    expect(displayName("Иван", "Петров")).toBe("Иван Петров");
  });

  it("falls back to @username", () => {
    expect(displayName(null, null, "dev_user")).toBe("@dev_user");
  });

  it("falls back to a generic label as last resort", () => {
    expect(displayName(null, null, null)).toBe("Профиль");
  });
});
