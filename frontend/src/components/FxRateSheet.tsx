/** Поповер «Курс и цены» — раскрывается тапом по курсу в статусной строке.
 *
 *  ===== Почему поповер, а не шторка =====
 *
 *  Панель была верхней шторкой во всю ширину и провалилась: она вставала в
 *  8px под строкой с прямой горизонтальной кромкой от края до края, набирала
 *  88% высоты экрана и проходила эту же высоту за 260мс. Получался не ответ на
 *  тап, а второй экран, обрушившийся на первый.
 *
 *  Поповер (`from="anchor"` у SheetShell) отвечает ровно на то, чем этот тап
 *  является: сноска к строке, которая осталась на месте. Панель по ширине
 *  колонки, со всеми скруглёнными углами, раскрывается из самого курса и
 *  занимает не больше 62% экрана — страница под ней видна, и человек не
 *  теряет, где он.
 *
 *  ===== Почему здесь почти нет текста =====
 *
 *  Прежняя версия объясняла курс двумя абзацами прозы, подсказкой и списком
 *  вопросов-ответов. Но сюда заходят не читать, а ПРОВЕРИТЬ: дорого сейчас или
 *  нет, брать или подождать. На такой вопрос отвечают цифры, а проза только
 *  заставляет их искать — приходилось листать, чтобы добраться до графика.
 *
 *  Осталось то, по чему действительно принимают решение: куда курс идёт за
 *  неделю и за месяц и насколько сегодня отличается от обычного. Всё это
 *  считается из той же истории, что и так приходит на график (lib/fxStats) —
 *  лишних запросов нет.
 *
 *  Отдельной полосы «коридор месяца» здесь больше нет, и это не экономия места
 *  ради места. Она отвечала на вопрос «у верхней мы границы или у нижней» теми
 *  же данными и за тот же месяц, что и график прямо под ней, — то есть рисовала
 *  диапазон дважды, плоско и без формы. График отвечает на то же самое и вдобавок
 *  показывает ПУТЬ: сравнить последнюю точку с минимумом и максимумом на ней
 *  видно сразу. Две подписи с числами границ ушли вместе с полосой: на осях
 *  графика те же величины уже подписаны.
 *
 *  Прозы осталась одна строка, и она единственная, которая меняет ПОВЕДЕНИЕ:
 *  цена фиксируется при оформлении заявки, ловить удачный курс не нужно.
 *  Остальное объясняло механику, которую человеку знать необязательно.
 *
 *  Текущее значение и дельта приходят пропом (уже есть из /config/public,
 *  повторно не грузим). История — лениво при открытии.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import FxRateChart from "./FxRateChart";
import { SheetShell } from "./ScenarioSheet";
import { changeOver, fxStats, type HistoryPoint } from "../lib/fxStats";

const FORMAT = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PERCENT = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const HISTORY_DAYS = 30;
const WEEK_DAYS = 7;

/** Процент со знаком и цветом. null — данных не хватило, ячейка показывает
 *  прочерк, а не выдуманный ноль. */
function Delta({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="text-[15px] font-bold text-muted">—</span>;
  // Порог 0.05: ниже него значение округляется до «0,0», и стрелка рядом с
  // нулём сообщала бы направление, которого нет.
  const flat = Math.abs(percent) < 0.05;
  const up = percent > 0;
  return (
    <span className={`text-[15px] font-bold ${flat ? "text-text" : up ? "text-green" : "text-danger"}`}>
      {flat ? "0,0" : `${up ? "+" : "−"}${PERCENT.format(Math.abs(percent))}`}%
    </span>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      {children}
      <p className="mt-1 text-[11px] leading-tight text-muted">{label}</p>
    </div>
  );
}

export default function FxRateSheet({
  usdRate,
  onClose,
  anchorTopPx,
  anchorLeftPx,
}: {
  usdRate: { value: number; delta: number };
  onClose: () => void;
  /** Верхняя кромка поповера — нижняя кромка строки статуса. */
  anchorTopPx?: number;
  /** Центр нажатого курса: из него панель раскрывается. */
  anchorLeftPx?: number;
}) {
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ history: HistoryPoint[] }>(`/fx/history?days=${HISTORY_DAYS}`)
      .then((data) => { if (!cancelled) setHistory(data.history); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, []);

  const stats = useMemo(() => (history ? fxStats(history) : null), [history]);
  const week = useMemo(() => (history ? changeOver(history, WEEK_DAYS) : null), [history]);
  const month = useMemo(
    () => (history ? changeOver(history, history.length - 1) : null),
    [history],
  );

  const rising = usdRate.delta >= 0;
  const deltaFormatted = FORMAT.format(Math.abs(usdRate.delta));
  // Проверяем именно ОТФОРМАТИРОВАННУЮ строку, а не числовой порог из
  // fxFormat.ts (тот подобран под один знак после запятой в статусной строке) —
  // здесь FORMAT даёт два знака, и порог спрятал бы настоящие «0,02».
  const deltaRoundsToZero = deltaFormatted === "0,00";

  const updated = history?.length ? new Date(history[history.length - 1].date) : null;

  /** Подпись под графиком: границы месяца и, пока история неполная, честная
   *  оговорка про её длину.
   *
   *  Два НЕЗАВИСИМЫХ куска одной строки, а не одно условие на оба. Границы
   *  показываются, только когда курс за месяц вообще двигался (при min === max
   *  фраза «ходил от 83,05 до 83,05» — шум), а оговорка про историю от этого
   *  не зависит вовсе: короткая история остаётся короткой и при стоящем курсе.
   *  Сцепленные в одно условие, они гасили оговорку ровно в том случае, где
   *  она нужнее всего — когда данных совсем мало и курс на них не успел
   *  сдвинуться. */
  const rangeNote = stats && stats.max > stats.min
    ? `За месяц курс ходил от ${FORMAT.format(stats.min)} до ${FORMAT.format(stats.max)} ₽.`
    : "";
  const historyNote = history !== null && history.length >= 2 && history.length < HISTORY_DAYS
    ? "Историю копим с запуска — за полный месяц график будет позже."
    : "";
  const chartNote = [rangeNote, historyNote].filter(Boolean).join(" ");

  return (
    <SheetShell
      from="anchor"
      anchorTopPx={anchorTopPx}
      anchorLeftPx={anchorLeftPx}
      onClose={onClose}
      labelledBy="fx-rate-title"
    >
      {(close) => (
        <>
          <div className="flex items-start justify-between px-4 pb-0.5 pt-3">
            <div>
              <h2 id="fx-rate-title" className="text-[26px] font-extrabold leading-7 tracking-[-0.02em] text-text">
                {FORMAT.format(usdRate.value)}&nbsp;₽
              </h2>
              {!deltaRoundsToZero && (
                <p className={`mt-0.5 text-[12.5px] font-bold ${rising ? "text-green" : "text-danger"}`}>
                  {rising ? "▲" : "▼"} {deltaFormatted} за сутки
                </p>
              )}
            </div>
            <button
              onClick={() => close()}
              aria-label="Закрыть"
              className="tap flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mutedbg"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {/* Дата последней точки, а не «обновляется ежедневно»: обещание про
              регулярность ничего не говорит о том, свежие ли данные СЕЙЧАС. */}
          <p className="px-4 text-[11.5px] text-muted">
            Курс ЦБ РФ{updated ? ` · обновлён ${DAY.format(updated)}` : ""}
          </p>

          {/* Одна коробка на всё, а не три отдельных карточки с рамками.
              Числа, график и подпись под ним — это один ответ на один вопрос
              («дорого сейчас или нет»), и разрезанный на три обведённых блока
              он занимал на 60px больше ровно ради трёх линий, которые ничего
              не разделяли: между блоками и так пустое место. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-2.5">
            <div className="rounded-xl2 border border-border px-3 py-2.5">
              {/* Три числа в ряд: ближняя динамика, месячная и отклонение от
                  обычного. Именно они отвечают на «дорого сейчас или нет». */}
              <div className="flex gap-3">
                <Stat label={`за ${WEEK_DAYS} дней`}><Delta percent={week} /></Stat>
                <Stat label="за месяц"><Delta percent={month} /></Stat>
                <Stat label="к среднему за месяц">
                  <Delta percent={stats ? stats.vsAvgPercent : null} />
                </Stat>
              </div>

              <div className="mt-2.5 border-t border-border pt-2.5">
                {history === null ? (
                  <div className="skeleton h-[150px] w-full rounded-lg" />
                ) : history.length < 2 ? (
                  <p className="text-[12.5px] text-muted">Пока недостаточно данных для графика.</p>
                ) : (
                  <FxRateChart points={history} />
                )}

                {/* Пояснение к графику — строкой, а не полосой с бегунком.
                    Прежний «коридор месяца» рисовал тот же диапазон за тот же
                    месяц, что и график прямо над ним, только плоско и без
                    пути: две картинки одних и тех же данных подряд. Фраза
                    занимает строку вместо 70px и делает то, чего картинка не
                    умеет, — НАЗЫВАЕТ границы, чтобы их не считывали с оси. */}
                {chartNote && (
                  <p className="mt-2 text-[12px] leading-[1.4] text-muted">{chartNote}</p>
                )}
              </div>
            </div>

            {/* Единственная строка прозы, которая меняет поведение. Всё
                остальное объясняло механику, знать которую необязательно. */}
            <p className="mt-2.5 text-[12px] leading-[1.4] text-muted">
              Цена фиксируется в момент оформления заявки — ловить удачный курс не нужно.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
