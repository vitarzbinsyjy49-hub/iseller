/** График курса за 30 дней: линия, заливка, сетка и подписи обеих осей.
 *
 *  Геометрия целиком в `lib/fxChart.ts` — здесь только отрисовка.
 *
 *  Почему `vector-effect="non-scaling-stroke"`: SVG масштабируется по ширине
 *  экрана, и вместе с ним по умолчанию тянется толщина линии — на широком
 *  экране она становится жирнее, на узком тоньше. С этим атрибутом линия
 *  ровно 2 CSS-пикселя всегда, независимо от масштаба.
 *
 *  Подписи набраны обычным <text> внутри SVG, а не HTML поверх: так они
 *  привязаны к тем же координатам, что и линия, и не разъезжаются с ней при
 *  смене ширины.
 */
import { buildFxChart, type FxPoint } from "../lib/fxChart";

const VIEW = { width: 320, height: 164 };
// Левый жёлоб под цены, нижний — под даты. Правый край с запасом: последняя
// точка стоит на нём, и кружок не должен обрезаться.
const PLOT = { left: 46, right: 314, top: 10, bottom: 126 };

const PRICE = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function FxRateChart({ points }: { points: FxPoint[] }) {
  const chart = buildFxChart(points, PLOT);
  if (!chart) return null;

  const { line, area, yTicks, xTicks, last, plot } = chart;

  return (
    <svg
      viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
      className="w-full"
      role="img"
      aria-label={`График курса доллара за ${points.length} дней`}
    >
      {/* Сетка и подписи цены. Линии сетки бледнее рамки карточки: они
          помогают считывать высоту, но спорить с самим графиком не должны. */}
      {yTicks.map((tick) => (
        <g key={tick.value}>
          <line
            x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y}
            stroke="rgb(var(--app-border))" strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={plot.left - 8} y={tick.y}
            textAnchor="end" dominantBaseline="middle"
            fontSize="11" fill="rgb(var(--app-sub))"
          >
            {PRICE.format(tick.value)}
          </text>
        </g>
      ))}

      <polyline points={area} fill="rgb(var(--app-accent) / 0.10)" stroke="none" />
      <polyline
        points={line} fill="none"
        stroke="rgb(var(--app-accent))" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* Последняя точка: взгляд должен находить «сегодня» без поиска. Белая
          обводка отделяет кружок от линии и от заливки под ней. */}
      <circle cx={last.x} cy={last.y} r="4.5" fill="rgb(var(--app-surface))" />
      <circle cx={last.x} cy={last.y} r="3" fill="rgb(var(--app-accent))" />

      {xTicks.map((tick, index) => (
        <text
          key={tick.label + index}
          x={tick.x}
          y={VIEW.height - 6}
          // Крайние подписи прижимаются к своим краям, иначе первая уезжает в
          // жёлоб цен, а последняя — за правый край области.
          textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
          fontSize="11" fill="rgb(var(--app-sub))"
        >
          {tick.label}
        </text>
      ))}
    </svg>
  );
}
