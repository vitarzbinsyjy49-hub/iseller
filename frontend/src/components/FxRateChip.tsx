/** Курс USD на главной — пилюля в стиле SegmentedToggle, справа от тумблера
 *  «Категории/Бренды» (Home.tsx). Тап открывает FxRateSheet.
 *
 *  Форматирование — в lib/fxFormat.ts (тестируется отдельно, без DOM); здесь
 *  только JSX. null от formatFxChip означает «строк в fx_rate_history ещё
 *  нет» — рисуем ничего, а не 0/битый вид (см. спеку). */
import { formatFxChip } from "../lib/fxFormat";

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
      // v5.7.0: верх главной стал светлым, и чип вместе с ним. Подложки нет
      // вовсе — курс это справка, а не действие: он не обязан выглядеть кнопкой
      // рядом с поиском и категориями.
      className="tap flex h-11 shrink-0 items-center gap-1 rounded-full px-1 text-[12.5px] font-bold text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
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
    </button>
  );
}
