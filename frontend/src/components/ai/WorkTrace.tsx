/** Строка работы AI: что система делает сейчас и что сделала в итоге.
 *
 *  Пока идёт запрос — подпись и ТИКАЮЩИЙ СЧЁТЧИК СЕКУНД. Анимированных точек
 *  здесь намеренно нет: телеграм-вебвью гасит декларативную CSS-анимацию
 *  целиком, и три точки там просто замирают — ровно тот вид, который читается
 *  как зависший экран. Счётчик идёт по setInterval и не зависит ни от
 *  CSS-анимации, ни от кадров rAF (в скрытой вкладке rAF не вызывается вовсе).
 *
 *  После ответа строка не исчезает, а сворачивается в след: видно, ЧТО было
 *  сделано. Весь текст собирает чистая функция из lib/aiTrace.
 */
import { useEffect, useState } from "react";
import type { AiAnswer } from "./types";
import { runningLabel, traceText } from "../../lib/aiTrace";

type Props =
  | { state: "running"; startedAt: number }
  | { state: "done"; meta: AiAnswer["meta"] | undefined; elapsedMs: number };

export default function WorkTrace(props: Props) {
  if (props.state === "running") return <RunningTrace startedAt={props.startedAt} />;
  const text = traceText(props.meta, props.elapsedMs);
  // null — следу нечего сообщить (мгновенный детерминированный ответ). Пустая
  // строка выглядела бы как недогруженная.
  if (!text) return null;
  return <p className="mb-1.5 text-xs leading-4 text-muted">{text}</p>;
}

function RunningTrace({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, performance.now() - startedAt));
  useEffect(() => {
    // Полсекунды хватает секундному счётчику и вдвое дешевле, чем 250мс.
    const id = setInterval(() => setElapsed(Math.max(0, performance.now() - startedAt)), 500);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <p className="flex items-baseline gap-1.5 text-xs leading-4 text-muted">
      {/* role="status" — смена подписи на порогах 4с и 16с озвучивается
          скринридером. Сам счётчик из него исключён: иначе каждые полсекунды
          зачитывалось бы новое число. */}
      <span role="status">{runningLabel(elapsed)}</span>
      {/* tabular-nums: без него строка дёргается на смене ширины цифр. */}
      <span aria-hidden className="tabular-nums">· {Math.floor(elapsed / 1000)} с</span>
    </p>
  );
}
