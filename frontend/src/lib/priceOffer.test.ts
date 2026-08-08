import { describe, expect, it } from "vitest";
import {
  buildPriceOfferBody,
  parseOfferPrice,
  planReveal,
  priceGap,
  validateOfferPrice,
  validateOfferUrl,
} from "./priceOffer";

describe("validateOfferUrl", () => {
  it("принимает обычную ссылку", () => {
    expect(validateOfferUrl("https://www.mvideo.ru/p/1")).toBeNull();
  });

  it("принимает адрес без схемы — её теряют при копировании", () => {
    expect(validateOfferUrl("ozon.ru/product/1")).toBeNull();
  });

  it("отвергает пустое", () => {
    expect(validateOfferUrl("  ")).toBeTruthy();
  });

  it("отвергает текст без домена", () => {
    expect(validateOfferUrl("дешевле в соседнем магазине")).toBeTruthy();
  });

  it("отвергает ссылку на нас самих", () => {
    expect(validateOfferUrl("https://158.255.1.248.sslip.io/product/42")).toBeTruthy();
  });

  it("отвергает не-http схему", () => {
    expect(validateOfferUrl("javascript://alert(1)")).toBeTruthy();
  });
});

describe("validateOfferPrice", () => {
  it("пустое поле — не ошибка: цена необязательна", () => {
    expect(validateOfferPrice("")).toBeNull();
    expect(validateOfferPrice("   ")).toBeNull();
  });

  it("принимает число с пробелами и запятой", () => {
    expect(validateOfferPrice("97 500")).toBeNull();
    expect(validateOfferPrice("97500,50")).toBeNull();
  });

  it("отвергает текст", () => {
    expect(validateOfferPrice("дешевле")).toBeTruthy();
  });

  it("отвергает ноль и абсурд", () => {
    expect(validateOfferPrice("0")).toBeTruthy();
    expect(validateOfferPrice("999999999999")).toBeTruthy();
  });
});

describe("parseOfferPrice", () => {
  it("возвращает число", () => {
    expect(parseOfferPrice("97 500")).toBe(97500);
  });

  it("пустое и мусор — undefined, а не строка", () => {
    expect(parseOfferPrice("")).toBeUndefined();
    expect(parseOfferPrice("дешевле")).toBeUndefined();
  });
});

describe("buildPriceOfferBody", () => {
  it("без цены поля в metadata нет вовсе", () => {
    const body = buildPriceOfferBody(42, " https://ozon.ru/p/1 ", "");
    expect(body.metadata.competitor_url).toBe("https://ozon.ru/p/1");
    expect(body.metadata.origin).toBe("product_price_offer");
    expect("competitor_price" in body.metadata).toBe(false);
    expect("comment" in body.metadata).toBe(false);
  });

  it("с ценой и комментарием", () => {
    const body = buildPriceOfferBody(42, "ozon.ru/p/1", "97 500", "  завтра заберу ");
    expect(body.metadata.competitor_price).toBe(97500);
    expect(body.metadata.comment).toBe("завтра заберу");
  });
});

describe("planReveal", () => {
  const base = { measured: 300, previousHeight: 0, openingNow: true, reducedMotion: false };

  it("открытие — едем от нуля к измеренной высоте", () => {
    expect(planReveal(base)).toEqual({ kind: "move", from: 0, to: 300 });
  });

  it("смена содержимого внутри открытого — едем от прошлой высоты", () => {
    expect(planReveal({ ...base, openingNow: false, previousHeight: 300, measured: 120 }))
      .toEqual({ kind: "move", from: 300, to: 120 });
  });

  it("не измерили — показываем без анимации, а не прячем", () => {
    // Регрессия: раньше нулевая высота замораживала блок закрытым, и это
    // выглядело как неработающая кнопка.
    expect(planReveal({ ...base, measured: 0 })).toEqual({ kind: "instant" });
    expect(planReveal({ ...base, measured: 0, reducedMotion: true })).toEqual({ kind: "instant" });
  });

  it("«уменьшить движение»: открытие проявляется, а не выезжает", () => {
    expect(planReveal({ ...base, reducedMotion: true })).toEqual({ kind: "fade" });
  });

  it("«уменьшить движение»: смена содержимого просто показывается", () => {
    expect(planReveal({ ...base, reducedMotion: true, openingNow: false, previousHeight: 300 }))
      .toEqual({ kind: "instant" });
  });

  it("ехать некуда — не притворяемся, что едем", () => {
    expect(planReveal({ ...base, openingNow: false, previousHeight: 300, measured: 300 }))
      .toEqual({ kind: "instant" });
  });
});

describe("priceGap", () => {
  it("считает разницу, когда у них дешевле", () => {
    expect(priceGap(104000, "97500")).toBe(6500);
  });

  it("не обещает выгоды, когда её нет", () => {
    expect(priceGap(104000, "110000")).toBeNull();
    expect(priceGap(104000, "104000")).toBeNull();
  });

  it("нечего сравнивать — null", () => {
    expect(priceGap(104000, "")).toBeNull();
    expect(priceGap(null, "97500")).toBeNull();
  });
});
