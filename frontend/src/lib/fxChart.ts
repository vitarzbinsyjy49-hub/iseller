/** Геометрия графика курса за 30 дней: линия, заливка, подписи осей.
 *
 *  Пришло на смену `sparkline.ts`. Тот рисовал только линию, растягивая её от
 *  минимума до максимума на 70 пикселях высоты: дневные колебания в пару
 *  копеек превращались в почти вертикальные скачки, и график читался рваным.
 *  Плюс у него не было ни одной подписи — «растёт» видно, а насколько и с
 *  какого числа, нет.
 *
 *  Здесь всё наоборот: домен по вертикали шире данных на поля, подписи цены
 *  берутся из настоящих значений (минимум, середина, максимум), а не из круглых
 *  чисел, которых в данных нет. Функция чистая — без DOM, тестируется отдельно.
 */

export type FxPoint = { date: string; value: number };

export type FxChartGeometry = {
  /** Точки для <polyline> — линия курса. */
  line: string;
  /** Замкнутый контур той же линии до низа области — заливка под ней. */
  area: string;
  /** Подписи цены слева: значение и его высота. */
  yTicks: { value: number; y: number }[];
  /** Подписи дат снизу: текст и его горизонтальная позиция. */
  xTicks: { label: string; x: number }[];
  /** Последняя точка — на ней стоит кружок «вы здесь». */
  last: { x: number; y: number };
  /** Границы области рисования, чтобы компонент не повторял числа за нами. */
  plot: { left: number; right: number; top: number; bottom: number };
};

/** Поля сверху и снизу: без них линия упирается в край и выглядит обрезанной. */
const PADDING_RATIO = 0.12;

const DATE_FORMAT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  // Точка в конце сокращения («12 авг.») крадёт место и ничего не добавляет.
  return DATE_FORMAT.format(parsed).replace(/\.$/, "");
}

export function buildFxChart(
  points: FxPoint[],
  { left, right, top, bottom }: { left: number; right: number; top: number; bottom: number },
): FxChartGeometry | null {
  // Одна точка — это не график: линии из неё не выходит, а «график» из точки
  // вводит в заблуждение сильнее, чем честная надпись «данных пока мало».
  if (points.length < 2) return null;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  // Все значения равны (курс не двигался) — рисуем ровно по центру, без
  // деления на ноль и без ложной «динамики» из шума округления.
  const pad = span === 0 ? 1 : span * PADDING_RATIO;
  const domainMin = min - pad;
  const domainMax = max + pad;

  const width = right - left;
  const height = bottom - top;
  const stepX = width / (points.length - 1);
  // SVG Y растёт вниз, поэтому большее значение курса даёт МЕНЬШИЙ y.
  const toY = (value: number) => bottom - ((value - domainMin) / (domainMax - domainMin)) * height;
  const round = (n: number) => Math.round(n * 100) / 100;

  const coords = points.map((point, index) => ({
    x: round(left + index * stepX),
    y: round(toY(point.value)),
  }));

  const line = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const area = `${left},${bottom} ${line} ${round(right)},${bottom}`;

  // Подписи цены — настоящие значения из данных, а не круглые числа: круглое
  // «92,00» на графике, где курс не был равен 92, обещает несуществующую точку.
  const mid = (min + max) / 2;
  const yTicks = (span === 0 ? [min] : [max, mid, min]).map((value) => ({
    value,
    y: round(toY(value)),
  }));

  // Три даты: начало, середина, конец. Больше не влезает на 375 пикселях, а
  // подписи внахлёст читаются хуже, чем их отсутствие.
  const xTickIndexes = points.length >= 3
    ? [0, Math.floor((points.length - 1) / 2), points.length - 1]
    : [0, points.length - 1];
  const xTicks = xTickIndexes.map((index) => ({
    label: formatDate(points[index].date),
    x: coords[index].x,
  }));

  return { line, area, yTicks, xTicks, last: coords[coords.length - 1], plot: { left, right, top, bottom } };
}
