import { describe, expect, it } from "vitest";
import {
  MACBOOK_CHOICES,
  SCENARIOS,
  SCENARIO_ORIGIN,
  buildScenarioLead,
  validateScenario,
} from "./scenario";

describe("buildScenarioLead", () => {
  it("trade_in -> корректный lead_type/source/metadata, комментарий в message", () => {
    const body = buildScenarioLead("trade_in", {
      device_type: "iphone", model: "iPhone 15 Pro", memory: "256 ГБ",
      condition: "normal", intent: "exchange", desired_device: "iPhone 16 Pro",
      message: "Небольшая царапина",
    }, "+7 900 111-22-33");
    expect(body.source).toBe("home");
    expect(body.lead_type).toBe("trade_in");
    expect(body.phone).toBe("+7 900 111-22-33");
    expect(body.message).toBe("Небольшая царапина");
    expect(body.metadata).toMatchObject({
      origin: SCENARIO_ORIGIN, device_type: "iphone", model: "iPhone 15 Pro",
      condition: "normal", intent: "exchange", desired_device: "iPhone 16 Pro",
    });
    // комментарий не должен попасть в metadata
    expect(body.metadata.message).toBeUndefined();
  });

  it("b2b -> quantity_range/city в metadata, source остаётся home", () => {
    const body = buildScenarioLead("b2b", {
      equipment: "laptops", quantity_range: "20-50", city: "Москва",
    }, "");
    expect(body.lead_type).toBe("b2b");
    expect(body.source).toBe("home");
    expect(body.phone).toBeNull();
    expect(body.metadata).toMatchObject({ equipment: "laptops", quantity_range: "20-50", city: "Москва" });
  });

  it("wholesale -> category/quantity_range, пустые поля отброшены", () => {
    const body = buildScenarioLead("wholesale", {
      category: "iphone", quantity_range: "10-30", city: "Казань", budget: "",
    }, "");
    expect(body.lead_type).toBe("wholesale");
    expect(body.metadata.budget).toBeUndefined();      // пусто -> нет ключа
    expect(body.metadata).toMatchObject({ category: "iphone", quantity_range: "10-30", city: "Казань" });
  });

  it("всегда проставляет origin", () => {
    for (const key of ["trade_in", "b2b", "wholesale"] as const) {
      expect(buildScenarioLead(key, {}, "").metadata.origin).toBe(SCENARIO_ORIGIN);
    }
  });
});

describe("validateScenario", () => {
  it("требует обязательные поля", () => {
    expect(validateScenario("trade_in", {}, false, "")).toMatch(/Заполните/);
    const full = { device_type: "iphone", model: "X", condition: "normal", intent: "sell" };
    expect(validateScenario("trade_in", full, false, "")).toBeNull();
  });

  it("требует телефон, только если requirePhone", () => {
    const full = { equipment: "laptops", quantity_range: "1-5", city: "Москва" };
    expect(validateScenario("b2b", full, true, "")).toMatch(/телефон/i);
    expect(validateScenario("b2b", full, true, "+79990001122")).toBeNull();
    expect(validateScenario("b2b", full, false, "")).toBeNull();
  });
});

describe("MACBOOK_CHOICES", () => {
  it("5 пунктов, последний soft, у всех непустой prefill без авто-submit-флага", () => {
    expect(MACBOOK_CHOICES).toHaveLength(5);
    expect(MACBOOK_CHOICES[4].soft).toBe(true);
    for (const c of MACBOOK_CHOICES) {
      expect(c.prefill.length).toBeGreaterThan(5);
      expect(c.prefill).not.toContain("auto=1");   // prefill, не команда авто-отправки
    }
  });
});

describe("SCENARIOS config", () => {
  it("у каждого сценария есть обязательные chips и textarea-комментарий", () => {
    for (const key of ["trade_in", "b2b", "wholesale"] as const) {
      const cfg = SCENARIOS[key];
      expect(cfg.leadType).toBe(key);
      expect(cfg.fields.some((f) => f.kind === "chips" && f.required)).toBe(true);
      expect(cfg.fields.some((f) => f.kind === "textarea")).toBe(true);
    }
  });
});
