/** Форматирование курса USD для чипа/шторки главной (см. lib/appConfig.ts —
 *  PublicConfig["usd_rate"]). Чистая функция, без DOM — тестируется
 *  изолированно, как остальная логика в этом каталоге (motion.ts, sparkline.ts). */
const FORMAT = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatFxChip(
  usdRate: { value: number; delta: number } | null,
): { value: string; delta: string | null; rising: boolean } | null {
  if (usdRate === null) return null;
  // Дельта < 0.05 округляется до "0,0" — стрелка рядом с нулём бессмысленна
  // и гарантированно случается в день запуска (одна строка истории — дельта
  // ровно 0) и после каждых выходных (ЦБ не публикует курс по субботам и
  // воскресеньям, понедельничная строка может совпасть с пятничной).
  const roundsToZero = Math.abs(usdRate.delta) < 0.05;
  return {
    value: FORMAT.format(usdRate.value),
    delta: roundsToZero ? null : FORMAT.format(Math.abs(usdRate.delta)),
    rising: usdRate.delta >= 0,
  };
}
