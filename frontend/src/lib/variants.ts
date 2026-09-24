/** Варианты одной модели на странице товара: цвет, память, конфигурация, SIM…
 *
 *  Каждый вариант — отдельный товар (так его заводит прайс поставщика), а
 *  переключатель просто уводит на соседний. Набор осей у линеек свой (у Mac —
 *  «Конфигурация», у iPad — «Связь»), поэтому экран строит ряды из того, что
 *  пришло с backend (services/variants.py), а не из списка в коде.
 *
 *  Правила выбора соседа живут здесь, а не в компоненте: их легко сломать
 *  незаметно, и они покрыты тестами. */

export type VariantValues = Record<string, string>;

export type VariantOption = {
  id: number;
  values: VariantValues;
  regions: string[];
  price: number;
  in_stock: boolean;
};

export type Variants = {
  axes: { name: string; values: string[] }[];
  current: { values: VariantValues; regions: string[] };
  options: VariantOption[];
};

/** Сводка семейства на карточке ленты: «от X ₽» и кружки цветов. */
export type FamilyInfo = {
  model: string;
  count: number;
  min_price: number;
  colors: string[];
};

export const COLOR_AXIS = "Цвет";

/** Что жальче потерять при вынужденном компромиссе. Цвет видно сразу, и
 *  подмена Burgundy на чёрный — самый заметный сюрприз; объём и конфигурация
 *  — второй по важности выбор; SIM и комплектация большинству безразличны,
 *  их уступаем первыми. Незнакомая ось получает средний вес. */
const WEIGHT: Record<string, number> = {
  [COLOR_AXIS]: 8, "Память": 4, "Конфигурация": 4, "Связь": 2, "SIM": 1, "Комплектация": 1,
};
const weight = (axis: string) => WEIGHT[axis] ?? 2;

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
 *  берём вариант, совпадающий по более важным осям; при равенстве — в наличии
 *  и дешевле. Регион не ось: из одинаковых версий — самая дешёвая. */
export function pickVariant(v: Variants, axis: string, value: string): VariantOption | null {
  const pool = v.options.filter((o) => o.values[axis] === value);
  if (pool.length === 0) return null;
  const others = v.axes.map((a) => a.name).filter((a) => a !== axis);
  const score = (o: VariantOption) =>
    others.reduce((sum, a) => sum + (o.values[a] === v.current.values[a] ? weight(a) : 0), 0);
  return [...pool].sort((a, b) => score(b) - score(a) || better(a, b))[0];
}

/** Есть ли значение оси в сочетании с уже выбранными остальными осями.
 *  Нет — кнопка остаётся нажимаемой (уведёт на ближайший вариант), но
 *  рисуется приглушённой, чтобы переход не был сюрпризом. */
export function isExact(v: Variants, axis: string, value: string): boolean {
  const others = v.axes.map((a) => a.name).filter((a) => a !== axis);
  return v.options.some((o) =>
    o.values[axis] === value && others.every((a) => o.values[a] === v.current.values[a]));
}

/** Те же значения всех осей, но другой регион — «другие версии». */
export function otherVersions(v: Variants, currentId: number): VariantOption[] {
  const names = v.axes.map((a) => a.name);
  return v.options
    .filter((o) => o.id !== currentId && names.every((a) => o.values[a] === v.current.values[a]))
    .sort(better);
}

/** Цвет корпуса -> оттенок кружка. Сначала точное имя, потом по словам
 *  («Ceramic Pink», «Sky Blue» -> pink, blue). Незнакомый цвет получает
 *  нейтральный серый и всё равно показывается: пропавший вариант хуже
 *  неточного кружка. */
const COLOR_HEX: Record<string, string> = {
  black: "#1d1d1f", "space black": "#2e2c2e", "jet black": "#0b0b0c", midnight: "#2d3440",
  white: "#f2f1ed", starlight: "#efe7da", silver: "#e3e4e5", "space gray": "#7d7e80",
  glacier: "#b9ceda", burgundy: "#6e2639", orange: "#e8793a", blue: "#3e5a78",
  "sky blue": "#c5d7e6", "mist blue": "#aebfd3", sage: "#b9c4a7", lavender: "#cbbfe0",
  pink: "#f1c9cf", gold: "#e6d2b0", purple: "#b8a3cf", green: "#b7cdb1", yellow: "#f3dc8b",
  red: "#b3263a", copper: "#b87333", nickel: "#b8b6ae", topaz: "#d9a15b", patina: "#6f8f86",
  plum: "#7b3f61", velvet: "#8c1c3a", silk: "#e9c9a6", camouflage: "#8a8f7a", teal: "#3f8a8c",
  indigo: "#3b4a8c", pearl: "#ece7df",
};

export function colorHex(color: string): string {
  const key = color.trim().toLowerCase();
  if (COLOR_HEX[key]) return COLOR_HEX[key];
  for (const word of key.split(/[\s/]+/).reverse()) {
    if (COLOR_HEX[word]) return COLOR_HEX[word];
  }
  return "#c7c7cc";
}

/** Подпись значения на кнопке: у SIM коды читаются хуже слов. */
export function valueLabel(axis: string, value: string): string {
  if (axis === "SIM") {
    if (value === "SIM+eSIM") return "SIM + eSIM";
    if (value === "eSIM") return "Только eSIM";
  }
  return value;
}
