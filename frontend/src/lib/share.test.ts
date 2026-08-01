import { describe, expect, it } from "vitest";
import { pickShareTarget, productDeepLink, shareText, telegramShareUrl } from "./share";

describe("productDeepLink", () => {
  it("собирает ссылку через бота", () => {
    expect(productDeepLink("isellerAIbot", 42)).toBe("https://t.me/isellerAIbot?start=product_42");
  });

  it("терпит @ и пробелы в имени бота", () => {
    expect(productDeepLink(" @isellerAIbot ", 7)).toBe("https://t.me/isellerAIbot?start=product_7");
  });

  it("без имени бота ссылки нет", () => {
    // Иначе получилась бы ссылка вида t.me/?start=... — она ведёт в никуда.
    expect(productDeepLink("", 42)).toBeNull();
    expect(productDeepLink(null, 42)).toBeNull();
    expect(productDeepLink(undefined, 42)).toBeNull();
  });

  it("отвергает бессмысленный id", () => {
    expect(productDeepLink("bot", 0)).toBeNull();
    expect(productDeepLink("bot", -5)).toBeNull();
    expect(productDeepLink("bot", NaN)).toBeNull();
  });
});

describe("shareText", () => {
  it("добавляет цену — с ней пересылают, без неё нет", () => {
    expect(shareText("iPhone 17 Pro", "94 000 ₽")).toBe("iPhone 17 Pro — 94 000 ₽");
  });

  it("без цены остаётся одно название", () => {
    expect(shareText("iPhone 17 Pro", "")).toBe("iPhone 17 Pro");
  });
});

describe("telegramShareUrl", () => {
  it("экранирует ссылку и текст", () => {
    const url = telegramShareUrl("https://t.me/bot?start=product_1", "iPhone — 94 000 ₽");
    expect(url).toContain("url=https%3A%2F%2Ft.me%2Fbot%3Fstart%3Dproduct_1");
    expect(url).toContain("text=iPhone");
    // Без экранирования «?start=» из ссылки съел бы параметр text.
    expect(url.split("&text=")).toHaveLength(2);
  });
});

describe("pickShareTarget", () => {
  const base = {
    botUsername: "isellerAIbot",
    productId: 42,
    title: "iPhone 17 Pro",
    price: "94 000 ₽",
    fallbackUrl: "https://shop.example/product/42",
    hasNativeShare: true,
  };

  it("внутри Telegram делится deep link'ом, а НЕ адресом Mini App", () => {
    // Главное требование фичи: по внутреннему адресу получатель попадает в веб
    // без Telegram-авторизации и видит «Не удалось войти».
    const target = pickShareTarget({ ...base, insideTelegram: true });
    expect(target.kind).toBe("telegram");
    expect(target.link).toBe("https://t.me/isellerAIbot?start=product_42");
    expect(target.link).not.toContain("shop.example");
  });

  it("вне Telegram тоже предпочитает deep link", () => {
    // Ссылка должна работать у ЛЮБОГО получателя, даже если отправитель в вебе.
    const target = pickShareTarget({ ...base, insideTelegram: false });
    expect(target.kind).toBe("native");
    expect(target.link).toBe("https://t.me/isellerAIbot?start=product_42");
  });

  it("без бота откатывается на обычный адрес, а не молчит", () => {
    const target = pickShareTarget({ ...base, insideTelegram: true, botUsername: "" });
    expect(target.kind).toBe("native");
    expect(target.link).toBe("https://shop.example/product/42");
  });

  it("без системного share остаётся буфер обмена", () => {
    const target = pickShareTarget({
      ...base, insideTelegram: false, hasNativeShare: false, botUsername: "",
    });
    expect(target).toEqual({ kind: "clipboard", link: "https://shop.example/product/42" });
  });
});
