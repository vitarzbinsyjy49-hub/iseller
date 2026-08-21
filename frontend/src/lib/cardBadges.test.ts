import { describe, expect, it } from "vitest";
import { MAX_CARD_BADGES, cardBadges } from "./cardBadges";

describe("cardBadges", () => {
  it("обычный товар без поводов — без бейджей", () => {
    expect(cardBadges({}, null)).toEqual([]);
  });

  it("показывает по одному поводу", () => {
    expect(cardBadges({ is_legendary: true }, null)).toEqual(["legendary"]);
    expect(cardBadges({}, 15)).toEqual(["discount"]);
    expect(cardBadges({ is_hot: true }, null)).toEqual(["hot"]);
    expect(cardBadges({ condition: "used" }, null)).toEqual(["used"]);
  });

  it("никогда не показывает больше двух", () => {
    // Стопка заливок поверх фотографии перестаёт что-либо выделять: когда
    // выделено всё, не выделено ничто.
    const everything = cardBadges(
      { is_legendary: true, is_hot: true, condition: "used" }, 20,
    );
    expect(everything).toHaveLength(MAX_CARD_BADGES);
    expect(everything).toEqual(["legendary", "discount"]);
  });

  it("держит приоритет: редкое важнее общего", () => {
    expect(cardBadges({ is_hot: true, condition: "used" }, null)).toEqual(["hot", "used"]);
    expect(cardBadges({ is_hot: true }, 10)).toEqual(["discount", "hot"]);
    expect(cardBadges({ is_legendary: true, is_hot: true }, null)).toEqual(["legendary", "hot"]);
  });

  it("нулевая и отрицательная скидка бейджем не считается", () => {
    // discountPct отдаёт null, когда старая цена не даёт выгоды, но ноль из
    // другого источника не должен превращаться в «−0%».
    expect(cardBadges({}, 0)).toEqual([]);
    expect(cardBadges({}, -5)).toEqual([]);
  });

  it("восстановленное состояние бейджа «Б/у» не получает", () => {
    // refurbished — не то же самое, что бывшее в употреблении, и подписывать
    // его чужим словом значит вводить в заблуждение о том, что покупают.
    expect(cardBadges({ condition: "refurbished" }, null)).toEqual([]);
    expect(cardBadges({ condition: "new" }, null)).toEqual([]);
  });

  it("предел вынесен в константу, а не зашит в вызовах", () => {
    expect(MAX_CARD_BADGES).toBe(2);
  });
});
