import { describe, expect, it } from "vitest";
import { productName } from "./productName";

describe("productName", () => {
  it("срезает ведущий бренд у Apple — «iPhone» называет производителя сам", () => {
    expect(productName({ title: "Apple iPhone 17 256 ГБ Black", brand: "Apple" }))
      .toBe("iPhone 17 256 ГБ Black");
  });

  it("сохраняет бренд там, где он ЧАСТЬ имени модели", () => {
    // «Watch Series 11» — так эти часы не называет никто: слово «Watch» само
    // по себе просто «часы». 18 таких позиций в каталоге на момент правки.
    expect(productName({ title: "Apple Watch Series 11 42mm Jet Black", brand: "Apple" }))
      .toBe("Apple Watch Series 11 42mm Jet Black");
    expect(productName({ title: "Apple Watch Ultra 4, 49 мм", brand: "Apple" }))
      .toBe("Apple Watch Ultra 4, 49 мм");
    expect(productName({ title: "Apple TV 4K 128 ГБ", brand: "Apple" }))
      .toBe("Apple TV 4K 128 ГБ");
    expect(productName({ title: "Apple Pencil Pro", brand: "Apple" }))
      .toBe("Apple Pencil Pro");
  });

  it("срезает бренд у линеек, которые узнаются сами", () => {
    // Их 288 против 18 исключений — правило именно такое, а не наоборот.
    const cases: [string, string][] = [
      ["Apple MacBook Air 13 Midnight (M4 16GB 512GB)", "MacBook Air 13 Midnight (M4 16GB 512GB)"],
      ["Apple iMac M3 (8/10/256) Blue", "iMac M3 (8/10/256) Blue"],
      ["Apple Mac Mini M4 (16/512)", "Mac Mini M4 (16/512)"],
      ["Apple iPad Pro 13 M5", "iPad Pro 13 M5"],
      ["Apple AirPods Pro 3", "AirPods Pro 3"],
      ["Apple Magic Keyboard", "Magic Keyboard"],
    ];
    for (const [title, expected] of cases) {
      expect(productName({ title, brand: "Apple" })).toBe(expected);
    }
  });

  it("исключение смотрит на слово, а не на подстроку", () => {
    // «Watchband» — не «Watch»: пунктуация снимается, но слово должно совпасть
    // целиком, иначе исключение расползётся на всё, что с него начинается.
    expect(productName({ title: "Apple Watchband Sport 45", brand: "Apple" }))
      .toBe("Watchband Sport 45");
    // А запятая сразу после слова исключению не мешает.
    expect(productName({ title: "Apple Watch, Series 11", brand: "Apple" }))
      .toBe("Apple Watch, Series 11");
  });

  it("сохраняет бренд у Dyson — без него модель не опознаётся", () => {
    expect(productName({ title: "Dyson V16 Piston Animal SV53", brand: "Dyson" }))
      .toBe("Dyson V16 Piston Animal SV53");
  });

  it("подставляет бренд, если его в названии нет вовсе", () => {
    // Так заведены приставки: бренд Sony, а название начинается с линейки.
    expect(productName({ title: "PlayStation 5 Pulse Elite White", brand: "Sony" }))
      .toBe("Sony PlayStation 5 Pulse Elite White");
  });

  it("предпочитает title_clean — в нём уже нет кодов стран", () => {
    expect(productName({
      title: "Apple iPhone 17 256 ГБ Sage (IN, SIM+eSIM)",
      title_clean: "Apple iPhone 17 256 ГБ Sage (SIM+eSIM)",
      brand: "Apple",
    })).toBe("iPhone 17 256 ГБ Sage (SIM+eSIM)");
  });

  it("не трогает пометки, различающие позиции и объясняющие цену", () => {
    // SIM+eSIM различает разные SKU, [ASIS] — витринный образец, то есть
    // причина, по которой аппарат дешевле. Срезать нельзя ни то, ни другое.
    expect(productName({ title: "Apple iPhone 17 512 ГБ Sage [ASIS]", brand: "Apple" }))
      .toBe("iPhone 17 512 ГБ Sage [ASIS]");
    expect(productName({ title: "Apple iPhone 17 256 ГБ (SIM+eSIM)", brand: "Apple" }))
      .toBe("iPhone 17 256 ГБ (SIM+eSIM)");
  });

  it("срезает бренд независимо от регистра", () => {
    expect(productName({ title: "APPLE iPhone 17", brand: "apple" })).toBe("iPhone 17");
  });

  it("не срезает бренд из середины названия — только ведущий", () => {
    // Иначе аксессуар «Чехол для Apple iPhone» потерял бы смысл посреди фразы.
    expect(productName({ title: "Чехол для Apple iPhone 17", brand: "Apple" }))
      .toBe("Чехол для Apple iPhone 17");
  });

  it("не режет бренд, если он и есть всё название", () => {
    // Вырожденный случай заведения товара: пустая плитка хуже лишнего слова.
    expect(productName({ title: "Apple", brand: "Apple" })).toBe("Apple");
  });

  it("не срезает бренд, если он лишь начало слова", () => {
    // Проверка на пробел после бренда: без неё резало бы по живому.
    expect(productName({ title: "Applewatch Series 11", brand: "Apple" }))
      .toBe("Applewatch Series 11");
  });

  it("без бренда возвращает название как есть", () => {
    expect(productName({ title: "iPhone 17 256 ГБ" })).toBe("iPhone 17 256 ГБ");
    expect(productName({ title: "iPhone 17", brand: "" })).toBe("iPhone 17");
  });

  it("обрезает лишние пробелы по краям", () => {
    expect(productName({ title: "  Apple   iPhone 17  ", brand: "Apple" })).toBe("iPhone 17");
  });
});
