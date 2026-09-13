import { describe, expect, it } from "vitest";
import { managerLink, managerMessage } from "./managerLink";

/** Текст, который подставляется в чат с менеджером.
 *
 *  Отправить за человека Telegram не даёт и не должен: `?text=` кладёт текст в
 *  поле ввода, «отправить» жмёт он сам. Поэтому смысл подстановки не в
 *  экономии нажатия, а в снятии барьера «с чего начать» — именно из-за него
 *  люди не пишут, а не из-за лишнего тапа.
 */
describe("managerMessage", () => {
  it("без товара — общий текст", () => {
    expect(managerMessage(null)).toBe("Здравствуйте! Хочу проконсультироваться по технике.");
  });

  it("с товаром называет модель, цену и артикул", () => {
    const text = managerMessage({ title: "iPhone 17 Pro 256 ГБ", price: 119990, sku: "A-1234" });
    expect(text).toContain("iPhone 17 Pro 256 ГБ");
    expect(text).toContain("A-1234");
    // Разряды разделены НЕРАЗРЫВНЫМ пробелом (U+00A0) — так форматирует
    // Intl для ru-RU, и так правильно: обычный пробел позволил бы Telegram
    // перенести «119» и «990» на разные строки. Сравниваем, сняв его, чтобы
    // тест проверял число, а не типографику.
    expect(text.replace(/ /g, " ")).toContain("119 990 ₽");
  });

  it("без артикула не пишет пустых скобок", () => {
    const text = managerMessage({ title: "AirPods 5", price: 24990, sku: null });
    expect(text).not.toContain("()");
    expect(text).not.toContain("артикул");
  });

  it("без цены не выдумывает её", () => {
    // Предзаказ: цену подтверждает менеджер, в каталоге её нет. Написать
    // «0 ₽» или «— ₽» значило бы отправить менеджеру заведомую чушь.
    const text = managerMessage({ title: "iPhone 18 Pro", price: null, sku: "P-1" });
    expect(text).not.toContain("₽");
    expect(text).toContain("iPhone 18 Pro");
  });
});

describe("managerLink", () => {
  it("подставляет текст в ссылку менеджера", () => {
    const url = managerLink("https://t.me/iseller_manager", null);
    expect(url).toBe("https://t.me/iseller_manager?text=" + encodeURIComponent(managerMessage(null)));
  });

  it("сохраняет уже имеющиеся параметры ссылки", () => {
    const url = managerLink("https://t.me/iseller_manager?profile=1", null);
    expect(url).toContain("profile=1");
    expect(url).toContain("text=");
  });

  it("пустая ссылка остаётся пустой — вызывающий уводит в контакты", () => {
    // Конфиг мог не доехать. Собирать «?text=...» без адреса бессмысленно, а
    // возвращать строку-огрызок опасно: openExternalLink попробует её открыть.
    expect(managerLink("", null)).toBe("");
    expect(managerLink(undefined, null)).toBe("");
  });

  it("не трогает ссылку, в которой текст уже задан вручную", () => {
    // Ссылку настраивает владелец в .env. Если он сам дописал текст — значит,
    // так и хотел, и перетирать его нашим шаблоном нельзя.
    const url = managerLink("https://t.me/m?text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82", null);
    expect(url).toBe("https://t.me/m?text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82");
  });
});
