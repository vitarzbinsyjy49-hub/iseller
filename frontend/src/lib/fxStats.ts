/** Показатели курса за период — считаются из истории, которая и так приходит
 *  на график. Отдельного запроса к серверу для них не нужно.
 *
 *  Зачем они вообще. Прежняя шторка объясняла курс двумя абзацами текста и
 *  списком вопросов-ответов. Человек открывает её не читать, а ПРОВЕРИТЬ:
 *  дорого сейчас или нет, брать или подождать. На такой вопрос отвечают цифры,
 *  а не проза: где курс относительно месячного коридора, куда он идёт неделю,
 *  насколько сегодня отличается от обычного.
 *
 *  Чистые функции, без DOM — как вся логика в этом каталоге.
 */

/** Точка истории в том виде, в каком её отдаёт backend (`/api/fx/history`). */
export type HistoryPoint = { date: string; value: number };

export type FxStats = {
  /** Минимум и максимум за период — коридор, в котором курс жил. */
  min: number;
  max: number;
  /** Среднее за период: точка отсчёта для «дорого/дёшево сегодня». */
  avg: number;
  /** Последняя точка — сегодняшний курс. */
  last: number;
  /** На сколько процентов сегодня отличается от среднего. Знак значим. */
  vsAvgPercent: number;
};

/** Сводка по истории. null — считать нечего.
 *
 *  Именно null, а не нули: нулями экран нарисовал бы «курс 0 ₽» и «−100%»,
 *  причём выглядело бы это как настоящие данные. Пусто честнее неправды. */
export function fxStats(history: HistoryPoint[]): FxStats | null {
  if (history.length === 0) return null;
  const values = history.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  // История приходит по возрастанию даты (см. services/fx_rate.history),
  // поэтому «сегодня» — последняя точка, а не первая.
  const last = values[values.length - 1];
  const vsAvgPercent = avg === 0 ? 0 : ((last - avg) / avg) * 100;
  return { min, max, avg, last, vsAvgPercent };
}

/** Изменение за последние `days` дней, в процентах. null — данных не хватает.
 *
 *  Сравнивается последняя точка с точкой, отстоящей на `days` позиций назад.
 *  Если истории короче окна, возвращается null, а НЕ сравнение с самой ранней
 *  точкой: подпись «за 30 дней» под таким числом соврала бы — данных за 30 дней
 *  у нас в этом случае просто нет. */
export function changeOver(history: HistoryPoint[], days: number): number | null {
  if (history.length < days + 1) return null;
  const last = history[history.length - 1].value;
  const past = history[history.length - 1 - days].value;
  if (past === 0) return null;
  return ((last - past) / past) * 100;
}

/** Где значение внутри коридора: 0 — у нижней границы, 1 — у верхней.
 *
 *  Вырожденный коридор (курс не менялся весь период) отдаёт середину, а не
 *  деление на ноль: иначе отметка уезжает из шкалы с NaN. */
export function positionInRange(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  const t = (value - min) / (max - min);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
