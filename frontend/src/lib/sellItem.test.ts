import { describe, expect, it } from "vitest";
import {
  buildSellItemLead, sellableCategories, validateSellItem, type SellItemValues,
} from "./sellItem";

const FULL: SellItemValues = {
  category: "смартфоны", title: "iPhone 13 Pro 128 ГБ",
  state: "Хорошее, есть следы", price: "45000", comment: "Полный комплект",
};

describe("buildSellItemLead", () => {
  it("собирает тело заявки из значений формы", () => {
    const body = buildSellItemLead(FULL, ["/api/uploads/a.jpg", "/api/uploads/b.jpg"], "+79990000000");
    expect(body).toEqual({
      source: "home",
      lead_type: "sell_item",
      phone: "+79990000000",
      message: "Полный комплект",
      metadata: {
        category: "смартфоны", title: "iPhone 13 Pro 128 ГБ",
        state: "Хорошее, есть следы", price_wanted: 45000,
        photos: ["/api/uploads/a.jpg", "/api/uploads/b.jpg"],
      },
    });
  });

  it("комментарий необязателен — message становится null", () => {
    const body = buildSellItemLead({ ...FULL, comment: "" }, ["/api/uploads/a.jpg"], "+79990000000");
    expect(body.message).toBeNull();
  });
});

describe("validateSellItem", () => {
  it("требует категорию, название, цену, минимум одно фото и телефон", () => {
    expect(validateSellItem(FULL, [], "")).toBe("Оставьте телефон — иначе не сможем связаться");
    expect(validateSellItem(FULL, ["/api/uploads/a.jpg"], "")).toBe("Оставьте телефон — иначе не сможем связаться");
    expect(validateSellItem(FULL, [], "+79990000000")).toBe("Добавьте хотя бы одно фото");
    expect(validateSellItem({ ...FULL, price: "0" }, ["/api/uploads/a.jpg"], "+79990000000")).toBe("Укажите цену больше нуля");
    expect(validateSellItem({ ...FULL, title: "" }, ["/api/uploads/a.jpg"], "+79990000000")).toBe("Укажите, что за товар");
    expect(validateSellItem(FULL, ["/api/uploads/a.jpg"], "+79990000000")).toBeNull();
  });
});

describe("sellableCategories", () => {
  it("убирает виртуальные «Скидки» — продать разрез витрины нельзя", () => {
    const keys = sellableCategories([
      { key: "смартфоны", label: "Смартфоны" },
      { key: "__sale__", label: "Скидки" },
      { key: "ноутбуки", label: "Ноутбуки" },
    ]).map((c) => c.key);
    expect(keys).toEqual(["смартфоны", "ноутбуки"]);
  });
  it("пустой/отсутствующий список -> []", () => {
    expect(sellableCategories(undefined)).toEqual([]);
    expect(sellableCategories(null)).toEqual([]);
  });
});
