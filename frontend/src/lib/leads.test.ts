import { describe, expect, it } from "vitest";
import { leadMetadataRows, leadTitle, leadTypeLabel } from "./leads";

describe("leadTypeLabel", () => {
  it("локализует типы, дефолт — Обычная", () => {
    expect(leadTypeLabel("trade_in")).toBe("Trade-In");
    expect(leadTypeLabel("b2b")).toBe("Для бизнеса");
    expect(leadTypeLabel("wholesale")).toBe("Опт");
    expect(leadTypeLabel(null)).toBe("Обычная");
    expect(leadTypeLabel("weird")).toBe("Обычная");
  });
});

describe("leadTitle", () => {
  it("Trade-In с моделью", () => {
    expect(leadTitle({ lead_type: "trade_in", metadata: { model: "iPhone 15 Pro" } }))
      .toBe("Trade-In · iPhone 15 Pro");
  });
  it("Опт с категорией (локализованной)", () => {
    expect(leadTitle({ lead_type: "wholesale", metadata: { category: "iphone" } }))
      .toBe("Оптовая заявка · iPhone");
  });
  it("бизнес без деталей", () => {
    expect(leadTitle({ lead_type: "b2b", metadata: {} })).toBe("Поставка для бизнеса");
  });
  it("обычная — product_title или Консультация", () => {
    expect(leadTitle({ lead_type: "general", product_title: "iPhone 16" })).toBe("iPhone 16");
    expect(leadTitle({ lead_type: "general", product_title: null })).toBe("Консультация");
  });
});

describe("leadMetadataRows", () => {
  it("скрывает origin и пустые, локализует значения", () => {
    const rows = leadMetadataRows({
      origin: "home_quick_scenario", device_type: "iphone", condition: "damaged",
      model: "iPhone 15", memory: "",
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Устройство"]).toBe("iPhone");
    expect(byLabel["Состояние"]).toBe("Есть повреждения");
    expect(byLabel["Модель"]).toBe("iPhone 15");
    expect("origin" in byLabel).toBe(false);
    expect("Память" in byLabel).toBe(false);   // пустое скрыто
  });
  it("неизвестный ключ показывается нейтрально", () => {
    const rows = leadMetadataRows({ custom_field: "значение" });
    expect(rows).toEqual([{ label: "custom_field", value: "значение" }]);
  });
  it("пустой/невалидный metadata -> []", () => {
    expect(leadMetadataRows(null)).toEqual([]);
    expect(leadMetadataRows({})).toEqual([]);
  });
});
