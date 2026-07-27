import { describe, expect, it } from "vitest";

import { safeExternalUrl, safeInternalRoute } from "./route";

describe("safeInternalRoute", () => {
  it("пропускает обычные внутренние маршруты без изменений", () => {
    expect(safeInternalRoute("/catalog?category=%D1%84%D0%B5%D0%BD")).toBe("/catalog?category=%D1%84%D0%B5%D0%BD");
    expect(safeInternalRoute("/product/42")).toBe("/product/42");
    expect(safeInternalRoute("/ai?q=hello&auto=1")).toBe("/ai?q=hello&auto=1");
  });

  it("режет protocol-relative адреса (уводят на чужой хост)", () => {
    expect(safeInternalRoute("//evil.com")).toBe("/catalog");
    expect(safeInternalRoute("//evil.com/phish")).toBe("/catalog");
  });

  it("режет backslash-обходы (браузер трактует \\ как /)", () => {
    expect(safeInternalRoute("\\\\evil.com")).toBe("/catalog");
    expect(safeInternalRoute("/\\evil.com")).toBe("/catalog");
    expect(safeInternalRoute("\\/evil.com")).toBe("/catalog");
  });

  it("режет абсолютные URL и опасные схемы", () => {
    expect(safeInternalRoute("https://evil.com")).toBe("/catalog");
    expect(safeInternalRoute("javascript:alert(1)")).toBe("/catalog");
    expect(safeInternalRoute("/javascript:alert(1)")).toBe("/catalog");
    expect(safeInternalRoute("data:text/html,<script>")).toBe("/catalog");
  });

  it("отдаёт fallback на мусор и не-строки", () => {
    expect(safeInternalRoute("")).toBe("/catalog");
    expect(safeInternalRoute(null)).toBe("/catalog");
    expect(safeInternalRoute(undefined)).toBe("/catalog");
    expect(safeInternalRoute(42)).toBe("/catalog");
    expect(safeInternalRoute("relative/path")).toBe("/catalog");
  });

  it("уважает переданный fallback", () => {
    expect(safeInternalRoute("https://evil.com", "/")).toBe("/");
  });
});

describe("safeExternalUrl", () => {
  it("пропускает http/https", () => {
    expect(safeExternalUrl("https://t.me/isellerAIbot")).toBe("https://t.me/isellerAIbot");
    expect(safeExternalUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("блокирует javascript: и прочие схемы", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull();
  });

  it("отдаёт null на пустое и не-строки", () => {
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
  });
});
