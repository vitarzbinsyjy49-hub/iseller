/** Форматирование курса USD для чипа/шторки главной (см. lib/appConfig.ts —
 *  PublicConfig["usd_rate"]). Чистая функция, без DOM — тестируется
 *  изолированно, как остальная логика в этом каталоге (motion.ts, sparkline.ts). */
const FORMAT = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatFxChip(
  usdRate: { value: number; delta: number } | null,
): { value: string; delta: string; rising: boolean } | null {
  if (usdRate === null) return null;
  return {
    value: FORMAT.format(usdRate.value),
    delta: FORMAT.format(Math.abs(usdRate.delta)),
    rising: usdRate.delta >= 0,
  };
}
