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
      className="tap flex h-11 shrink-0 items-center gap-1 rounded-full bg-white/[0.13] px-3.5 text-[12.5px] font-bold text-[color:var(--app-hero-chip-ink)] outline-none ring-1 ring-inset ring-white/15 focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <span>${formatted.value}</span>
      {formatted.delta !== null && (
        // Не text-green/text-danger: это токены для светлых поверхностей,
        // на тёмном hero-градиенте (--app-hero-bg) дают ~1.4:1/3.0:1 — провал
        // WCAG AA. Точная пара под тёмный фон — см. text-[#8fd4ff] в SceneTrust.tsx.
        <span className={formatted.rising ? "text-[#4ADE80]" : "text-[#F87171]"}>
          {formatted.rising ? "▲" : "▼"}{formatted.delta}
        </span>
      )}
    </button>
  );
}
