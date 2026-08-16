import { describe, expect, it } from "vitest";

import { actionRoute, safeExternalUrl, safeInternalRoute } from "./route";

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

describe("actionRoute", () => {
  it("категория ведёт в каталог с фильтром категории", () => {
    expect(actionRoute("category", "смартфоны")).toBe(
      "/catalog?category=%D1%81%D0%BC%D0%B0%D1%80%D1%82%D1%84%D0%BE%D0%BD%D1%8B",
    );
  });

  it("бренд ведёт в каталог с фильтром бренда", () => {
    // Dyson — бренд, а не категория: его товары лежат в «красота» и
    // «бытовая техника», плитка по категории вела в пустоту
    expect(actionRoute("brand", "Dyson")).toBe("/catalog?brand=Dyson");
  });

  it("AI без запроса ведёт в чат, с запросом — с предзаполнением", () => {
    expect(actionRoute("ai", "")).toBe("/ai");
    expect(actionRoute("ai", "макбук")).toBe("/ai?q=%D0%BC%D0%B0%D0%BA%D0%B1%D1%83%D0%BA");
  });

  it("неизвестный тип не роняет навигацию", () => {
    expect(actionRoute("нечто", "x")).toBe("/catalog");
  });

  it("sell_item ведёт на визард подачи заявки", () => {
    expect(actionRoute("sell_item")).toBe("/sell");
  });

  it("marketplace ведёт на витрину", () => {
    expect(actionRoute("marketplace")).toBe("/marketplace");
  });
});
