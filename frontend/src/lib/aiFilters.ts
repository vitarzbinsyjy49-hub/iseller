/** Разбор запроса моделью -> фильтры каталога.
 *
 *  Backend уже разбирает фразу («нужен айфон до 120 тысяч») на бюджет, бренд,
 *  категорию и состояние — `extract_filters`, и результат ПРИЕЗЖАЕТ на фронт в
 *  `meta.state`. До сих пор он никак не использовался и умирал вместе с
 *  ответом. Здесь он превращается в то, что человек видит и может открыть.
 *
 *  Смысл: фильтры каталога не надо рисовать руками — их называет человек
 *  словами, а модель переводит. Сузить выдачу дальше можно уже в самом
 *  каталоге, там фильтры видны и снимаются.
 *
 *  ГЛАВНОЕ ПРАВИЛО МОДУЛЯ: чип и адрес собираются из ОДНОГО набора полей. Чип
 *  обещает «нажми — увидишь это в каталоге», и фильтр, который каталог молча не
 *  применит, это обещание нарушает. Поэтому всё, чего каталог не умеет
 *  (исключение бренда, сценарии использования), не попадает ни туда, ни туда.
 */

/** `meta.state` от backend. Поля необязательные: это разбор, а не анкета. */
export type AiFilterState = {
  budget_max?: number | null;
  category?: string | null;
  brand?: string | null;
  condition?: string | null;
  in_stock_only?: boolean | null;
  /** Каталог исключать бренды не умеет — см. правило модуля. */
  excluded_brands?: string[] | null;
  /** Не фильтр каталога: «для фото», «для игр» — это про подбор, не про выборку. */
  use_cases?: string[] | null;
};

export type FilterChip = { key: string; label: string };

const CONDITION_LABEL: Record<string, string> = {
  new: "Новые",
  used: "Б/у",
  refurbished: "Восстановленные",
};

function budgetLabel(value: number): string {
  // Неразрывный пробел внутри числа — как в formatPrice: «120 000 ₽» не должно
  // разрываться переносом посреди суммы.
  return `до ${new Intl.NumberFormat("ru-RU").format(Math.round(value))} ₽`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Что показать человеку: «вот как я понял вашу фразу».
 *  Порядок постоянный и идёт от общего к частному: раздел, бренд, деньги. */
export function filterChips(state: AiFilterState | undefined): FilterChip[] {
  const chips: FilterChip[] = [];
  if (!state) return chips;

  if (state.category) chips.push({ key: "category", label: capitalize(state.category) });
  if (state.brand) chips.push({ key: "brand", label: state.brand });
  if (state.in_stock_only) chips.push({ key: "in_stock_only", label: "В наличии" });
  // Незнакомое состояние не выдумываем: подпись берётся из словаря или чипа нет.
  if (state.condition && CONDITION_LABEL[state.condition]) {
    chips.push({ key: "condition", label: CONDITION_LABEL[state.condition] });
  }
  // Ноль — это отсутствие бюджета, а не «до 0 ₽».
  if (typeof state.budget_max === "number" && state.budget_max > 0) {
    chips.push({ key: "budget_max", label: budgetLabel(state.budget_max) });
  }
  return chips;
}

/** Адрес каталога с теми же фильтрами. Имена параметров — те, что каталог
 *  действительно читает из URL (pages/Catalog.tsx). */
export function catalogHref(state: AiFilterState | undefined): string {
  if (!state) return "/catalog";
  const qs = new URLSearchParams();
  if (state.category) qs.set("category", state.category);
  if (state.brand) qs.set("brand", state.brand);
  if (state.in_stock_only) qs.set("in_stock", "1");
  if (state.condition && CONDITION_LABEL[state.condition]) qs.set("condition", state.condition);
  if (typeof state.budget_max === "number" && state.budget_max > 0) {
    qs.set("price_max", String(Math.round(state.budget_max)));
  }
  const query = qs.toString();
  return query ? `/catalog?${query}` : "/catalog";
}
