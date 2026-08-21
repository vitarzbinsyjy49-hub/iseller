/** Курс USD на главной — элемент справа от тумблера «Категории/Бренды»
 *  (Home.tsx). Тап открывает FxRateSheet.
 *
 *  Форматирование — в lib/fxFormat.ts (тестируется отдельно, без DOM); здесь
 *  только JSX. null от formatFxChip означает «строк в fx_rate_history ещё
 *  нет» — рисуем ничего, а не 0/битый вид (см. спеку). */
import { formatFxChip } from "../lib/fxFormat";
import { Icon } from "./icons";

export function FxRateChip({
  usdRate,
  onClick,
}: {
  usdRate: { value: number; delta: number } | null;
  onClick: () => void;
}) {
  const formatted = formatFxChip(usdRate);
  if (formatted === null) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      // Оформление — как у элементов ряда категорий рядом: та же волосяная
      // рамка и тот же радиус.
      //
      // Сначала подложку сняли совсем, рассудив, что курс — справка. Рассуждение
      // неверное: по нему ОТКРЫВАЕТСЯ шторка, то есть это действие, и выглядеть
      // оно обязано действием. Шеврон здесь не украшение — он единственное, что
      // говорит, что именно произойдёт по нажатию: развернётся ещё один слой, а
      // не откроется новый экран.
      className="tap flex h-11 shrink-0 items-center gap-1 rounded-field border border-border bg-surface px-3 text-[12.5px] font-bold text-text outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span>${formatted.value}</span>
      {formatted.delta !== null && (
        // Токены светлых поверхностей вернулись: фон под чипом теперь светлый.
        // Хардкоды #4ADE80/#F87171 стояли здесь ради контраста на тёмном
        // hero-градиенте — на светлом они, наоборот, не добирают.
        <span className={formatted.rising ? "text-green" : "text-danger"}>
          {formatted.rising ? "▲" : "▼"}{formatted.delta}
        </span>
      )}
      <Icon name="chevron-down" className="h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={2.2} />
    </button>
  );
}
