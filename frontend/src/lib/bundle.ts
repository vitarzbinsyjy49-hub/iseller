/** Состав комплекта из характеристик товара.
 *
 *  Отдельного поля под комплектацию в модели нет и заводить его ради одной
 *  витрины не стоит: контент-менеджер и так перечисляет содержимое в
 *  характеристике «В комплекте». Здесь это перечисление превращается в список
 *  для событийной страницы — единственное место, где мы его разбираем.
 *
 *  Одна позиция комплектом не считается: блок «что внутри» с единственной
 *  строкой просто повторяет заголовок страницы.
 */
const KEY = "в комплекте";

export function bundleItems(specs: Record<string, string> | undefined | null): string[] {
  if (!specs) return [];
  const raw = Object.entries(specs).find(([label]) => label.trim().toLowerCase() === KEY)?.[1];
  if (!raw) return [];
  const items = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length >= 2 ? items : [];
}
