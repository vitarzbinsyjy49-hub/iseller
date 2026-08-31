import { describe, expect, it } from "vitest";
import { auroraFor, DEFAULT_HEADER, hasAurora, headerColorFor } from "./AuroraBackground";

/** Маршруты, на которых фон включён намеренно. Дублируют карту в компоненте —
 *  в этом и смысл: строка отсюда пропадает только вместе с решением убрать фон
 *  с экрана, а не случайной правкой карты. */
const WITH_AURORA = ["/", "/ai", "/profile", "/loyalty", "/info", "/catalog"];
/** Экраны-«работа»: плотная сетка карточек или заполнение формы. */
const WITHOUT_AURORA = ["/cart", "/favorites", "/requests", "/history"];

describe("маршруты живого фона", () => {
  it.each(WITH_AURORA)("%s — фон есть, и у него полная схема", (path) => {
    const scheme = auroraFor(path);
    expect(scheme).not.toBeNull();
    expect(scheme!.variant).toBeTruthy();
    expect(scheme!.header).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(WITHOUT_AURORA)("%s — фона нет, верх обычного цвета страницы", (path) => {
    expect(hasAurora(path)).toBe(false);
    expect(headerColorFor(path)).toBe(DEFAULT_HEADER);
  });

  it("вложенный путь не наследует фон родителя", () => {
    expect(hasAurora("/ai/history")).toBe(false);
  });

  it("незнакомый маршрут не роняет расчёт цвета", () => {
    expect(headerColorFor("/чего-то-нет")).toBe(DEFAULT_HEADER);
  });
});

describe("карточка товара — единственный фон по префиксу", () => {
  it.each(["/product/12", "/product/999", "/product/abc-def"])(
    "%s — самый слабый фон, вариант faint",
    (path) => {
      const scheme = auroraFor(path);
      expect(scheme).not.toBeNull();
      expect(scheme!.variant).toBe("faint");
      expect(scheme!.header).toMatch(/^#[0-9a-f]{6}$/);
    },
  );

  it("раздел /product без id фона не получает", () => {
    expect(hasAurora("/product")).toBe(false);
    expect(headerColorFor("/product")).toBe(DEFAULT_HEADER);
  });
});

describe("цвет верхней плашки", () => {
  /** Telegram сам выбирает цвет значков («Закрыть», «…») по яркости шапки: на
   *  светлой — тёмные, на тёмной — белые. Переключение происходит около
   *  середины шкалы, и цвет из серой зоны даёт нечитаемые кнопки на части
   *  клиентов. Держим все оттенки заведомо светлыми. */
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  it.each([
    ...WITH_AURORA.map((p) => headerColorFor(p)),
    headerColorFor("/product/12"),
    DEFAULT_HEADER,
  ])("%s — светлый, значки Telegram останутся тёмными", (color) => {
    expect(luminance(color)).toBeGreaterThan(0.85);
  });

  it("оттенок отличается от цвета страницы — иначе перекрашивать незачем", () => {
    for (const path of [...WITH_AURORA, "/product/12"]) {
      expect(headerColorFor(path)).not.toBe(DEFAULT_HEADER);
    }
  });
});
