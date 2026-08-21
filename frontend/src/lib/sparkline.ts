/** Точки для SVG <polyline> мини-графика курса (шторка «Курс и цены»).
 *
 *  Чистая функция без DOM — тестируется изолированно, как scrollPositionAt/
 *  easeOutQuint в lib/motion.ts. SVG Y растёт вниз, поэтому большее значение
 *  курса даёт МЕНЬШИЙ y (выше на экране) — учтено ниже.
 */
export function toSparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `0,${height / 2}`;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = width / (values.length - 1);

  return values
    .map((v, i) => {
      const x = i * step;
      // span === 0 (все значения равны) — плоская линия по центру, деления на ноль нет.
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${x},${y}`;
    })
    .join(" ");
}
