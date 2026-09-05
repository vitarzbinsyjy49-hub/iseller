import { describe, expect, it } from "vitest";
import { formatPrice } from "./format";
import { leadMetadataRows, leadTitle, leadTypeLabel } from "./leads";

describe("leadTypeLabel", () => {
  it("локализует типы, дефолт — Обычная", () => {
    expect(leadTypeLabel("trade_in")).toBe("Trade-In");
    expect(leadTypeLabel("b2b")).toBe("Для бизнеса");
    expect(leadTypeLabel("wholesale")).toBe("Опт");
    expect(leadTypeLabel("sell_item")).toBe("Предложение товара");
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
  it("Предложение товара — с названием и без", () => {
    expect(leadTitle({ lead_type: "sell_item", metadata: { title: "iPhone 13 Pro" } }))
      .toBe("Предложение товара · iPhone 13 Pro");
    expect(leadTitle({ lead_type: "sell_item", metadata: {} })).toBe("Предложение товара");
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
  it("промокод из корзины — локализованные подписи и деньги, не сырые ключи", () => {
    const rows = leadMetadataRows({
      origin: "cart", promo_code: "START20", promo_discount: 500, subtotal: 12000,
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Промокод"]).toBe("START20");
    expect(byLabel["Скидка по промокоду"]).toBe(formatPrice(500));
    expect(byLabel["Сумма без скидки"]).toBe(formatPrice(12000));
    expect("promo_code" in byLabel).toBe(false);
  });
  it("заявка «Предложить товар» — подписи, цена деньгами, фото скрыты", () => {
    const rows = leadMetadataRows({
      origin: "sell_item", category: "смартфоны", title: "iPhone 13 Pro 128 ГБ",
      state: "Хорошее, есть следы", price_wanted: 45000,
      photos: ["/api/uploads/a.jpg", "/api/uploads/b.jpg"],
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Название"]).toBe("iPhone 13 Pro 128 ГБ");
    expect(byLabel["Состояние"]).toBe("Хорошее, есть следы");
    expect(byLabel["Желаемая цена"]).toBe(formatPrice(45000));
    expect(byLabel["Категория"]).toBe("смартфоны");
    // сырых ключей и простыни из URL на экране быть не должно
    expect("photos" in byLabel).toBe(false);
    expect("price_wanted" in byLabel).toBe(false);
    expect(rows.some((r) => r.value.includes("/api/uploads/"))).toBe(false);
  });
  it("пустой/невалидный metadata -> []", () => {
    expect(leadMetadataRows(null)).toEqual([]);
    expect(leadMetadataRows({})).toEqual([]);
  });
});

import { seenMarkFor, unseenLeadCount } from "./leads";

describe("unseenLeadCount", () => {
  const lead = (created: string, updated: string) => ({ created_at: created, updated_at: updated });

  it("считает заявку, которую менеджер тронул после последнего просмотра", () => {
    const leads = [lead("2026-09-01T10:00:00Z", "2026-09-03T12:00:00Z")];
    expect(unseenLeadCount(leads, "2026-09-02T00:00:00Z")).toBe(1);
  });

  it("НЕ считает только что созданную заявку: человек сам её и отправил", () => {
    const leads = [lead("2026-09-03T12:00:00Z", "2026-09-03T12:00:00Z")];
    expect(unseenLeadCount(leads, "2026-09-02T00:00:00Z")).toBe(0);
  });

  it("не считает изменения, которые уже видели", () => {
    const leads = [lead("2026-09-01T10:00:00Z", "2026-09-02T12:00:00Z")];
    expect(unseenLeadCount(leads, "2026-09-03T00:00:00Z")).toBe(0);
  });

  it("без отметки о просмотре бейдж не зажигается на всю историю", () => {
    const leads = [
      lead("2026-09-01T10:00:00Z", "2026-09-02T12:00:00Z"),
      lead("2026-08-01T10:00:00Z", "2026-08-05T12:00:00Z"),
    ];
    expect(unseenLeadCount(leads, null)).toBe(0);
  });

  it("пустой список даёт ноль", () => {
    expect(unseenLeadCount([], "2026-09-02T00:00:00Z")).toBe(0);
  });

  it("битые и отсутствующие даты не считаются изменениями", () => {
    const leads = [
      { created_at: null, updated_at: null },
      { created_at: "2026-09-01T10:00:00Z", updated_at: "не дата" },
    ];
    expect(unseenLeadCount(leads, "2026-09-02T00:00:00Z")).toBe(0);
  });
});

describe("seenMarkFor", () => {
  // Часы устройства всегда "выключены" здесь — если бы функция хоть раз
  // ушла в запасной путь без причины, тест бы это поймал.
  const now = () => "2099-01-01T00:00:00.000Z";

  it("пустой список — штампуем запасным временем (часы устройства)", () => {
    expect(seenMarkFor([], now)).toBe(now());
  });

  it("одна заявка — штампуем её updated_at, а не текущее время", () => {
    const leads = [{ updated_at: "2026-09-01T10:00:00Z" }];
    expect(seenMarkFor(leads, now)).toBe(new Date("2026-09-01T10:00:00Z").toISOString());
  });

  it("несколько заявок — берём САМЫЙ ПОЗДНИЙ updated_at, а не первый/последний в массиве", () => {
    const leads = [
      { updated_at: "2026-09-01T10:00:00Z" },
      { updated_at: "2026-09-05T08:00:00Z" },
      { updated_at: "2026-09-03T12:00:00Z" },
    ];
    expect(seenMarkFor(leads, now)).toBe(new Date("2026-09-05T08:00:00Z").toISOString());
  });

  it("битые/отсутствующие даты игнорируются, среди годных всё равно берём максимум", () => {
    const leads = [
      { updated_at: "не дата" },
      { updated_at: null },
      { updated_at: undefined },
      { updated_at: "2026-09-02T00:00:00Z" },
    ];
    expect(seenMarkFor(leads, now)).toBe(new Date("2026-09-02T00:00:00Z").toISOString());
  });

  it("все даты битые — запасной путь, как и для пустого списка", () => {
    const leads = [{ updated_at: "не дата" }, { updated_at: null }];
    expect(seenMarkFor(leads, now)).toBe(now());
  });
});
