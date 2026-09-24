/** Варианты одной модели на странице товара: память, цвет, SIM.
 *
 *  Каждый вариант — отдельный товар (так его заводит прайс поставщика), а
 *  переключатель просто уводит на соседний. Правила выбора соседа живут здесь,
 *  а не в компоненте: их легко сломать незаметно, и они покрыты тестами.
 *  Backend — services/variants.py. */

export type VariantAxis = "storage" | "color" | "sim";

export type VariantOption = {
  id: number;
  storage: string;
  color: string;
  sim: string;
  regions: string[];
  price: number;
  in_stock: boolean;
};

export type Variants = {
  axes: Record<VariantAxis, string[]>;
  current: { storage: string; color: string; sim: string; regions: string[] };
  options: VariantOption[];
};

/** Сводка семейства на карточке ленты: «от X ₽» и кружки цветов. */
export type FamilyInfo = {
  model: string;
  count: number;
  min_price: number;
  colors: string[];
};

const AXES: VariantAxis[] = ["storage", "color", "sim"];

/** Что жальче потерять при вынужденном компромиссе. Цвет видно сразу, и
 *  подмена Burgundy на чёрный — самый заметный сюрприз; память — второй по
 *  важности выбор; SIM большинству безразлична, её уступаем первой. */
const WEIGHT: Record<VariantAxis, number> = { color: 4, storage: 2, sim: 1 };

function better(a: VariantOption, b: VariantOption): number {
  // В наличии -> дешевле -> стабильный id: так же, как выбирает backend.
  if (a.in_stock !== b.in_stock) return a.in_stock ? -1 : 1;
  if (a.price !== b.price) return a.price - b.price;
  return a.id - b.id;
}

/** Куда вести при выборе `value` на оси `axis`.
 *
 *  Меняется ровно одна ось, остальные человек уже выбрал — их стараемся
 *  сохранить. Если точной комбинации нет (Burgundy на 2 ТБ только eSIM),
 *  берём вариант, совпадающий по большему числу остальных осей; при равенстве
 *  — в наличии и дешевле. Регион не ось: из одинаковых версий — самая дешёвая. */
export function pickVariant(
  v: Variants, axis: VariantAxis, value: string,
): VariantOption | null {
  const pool = v.options.filter((o) => o[axis] === value);
  if (pool.length === 0) return null;
  const others = AXES.filter((a) => a !== axis);
  const score = (o: VariantOption) =>
    others.reduce((sum, a) => sum + (o[a] === v.current[a] ? WEIGHT[a] : 0), 0);
  return [...pool].sort((a, b) => score(b) - score(a) || better(a, b))[0];
}

/** Есть ли значение оси в сочетании с уже выбранными остальными осями.
 *  Нет — кнопка остаётся нажимаемой (уведёт на ближайший вариант), но
 *  рисуется приглушённой, чтобы переход не был сюрпризом. */
export function isExact(v: Variants, axis: VariantAxis, value: string): boolean {
  const others = AXES.filter((a) => a !== axis);
  return v.options.some((o) => o[axis] === value && others.every((a) => o[a] === v.current[a]));
}

/** Та же память, цвет и SIM, но другой регион — «другие версии». */
export function otherVersions(v: Variants, currentId: number): VariantOption[] {
  return v.options
    .filter((o) => o.id !== currentId && AXES.every((a) => o[a] === v.current[a]))
    .sort(better);
}

/** Цвет корпуса -> оттенок кружка. Незнакомый цвет получает нейтральный серый
 *  и всё равно показывается: пропавший вариант хуже неточного кружка. */
const COLOR_HEX: Record<string, string> = {
  black: "#1d1d1f",
  "space black": "#2e2c2e",
  white: "#f2f1ed",
  silver: "#e3e4e5",
  glacier: "#b9ceda",
  burgundy: "#6e2639",
  orange: "#e8793a",
  blue: "#3e5a78",
  "mist blue": "#aebfd3",
  sage: "#b9c4a7",
  lavender: "#cbbfe0",
  pink: "#f1c9cf",
  gold: "#e6d2b0",
};

export function colorHex(color: string): string {
  return COLOR_HEX[color.trim().toLowerCase()] ?? "#c7c7cc";
}

/** Подпись SIM для кнопки: у товара её может не быть вовсе. */
export function simLabel(sim: string): string {
  if (sim === "SIM+eSIM") return "SIM + eSIM";
  if (sim === "eSIM") return "Только eSIM";
  return sim || "—";
}
