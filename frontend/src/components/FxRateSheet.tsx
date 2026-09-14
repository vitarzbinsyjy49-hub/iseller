/** Шторка «Курс и цены» — открывается тапом по курсу в статусной строке.
 *
 *  ===== Почему здесь почти нет текста =====
 *
 *  Прежняя версия объясняла курс двумя абзацами прозы, подсказкой и списком
 *  вопросов-ответов. Но сюда заходят не читать, а ПРОВЕРИТЬ: дорого сейчас или
 *  нет, брать или подождать. На такой вопрос отвечают цифры, а проза только
 *  заставляет их искать — приходилось листать, чтобы добраться до графика.
 *
 *  Осталось то, по чему действительно принимают решение: где курс в месячном
 *  коридоре, куда он идёт за неделю и за месяц, насколько сегодня отличается от
 *  обычного. Всё это считается из той же истории, что и так приходит на график
 *  (lib/fxStats) — лишних запросов нет.
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
import { changeOver, fxStats, positionInRange, type HistoryPoint } from "../lib/fxStats";

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
}: {
  usdRate: { value: number; delta: number };
  onClose: () => void;
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

  return (
    <SheetShell from="top" onClose={onClose} labelledBy="fx-rate-title">
      {(close) => (
        <>

          <div className="flex items-start justify-between px-5 pb-1 pt-4">
            <div>
              <h2 id="fx-rate-title" className="text-[30px] font-extrabold tracking-[-0.02em] text-text">
                {FORMAT.format(usdRate.value)}&nbsp;₽
              </h2>
              {!deltaRoundsToZero && (
                <p className={`mt-0.5 text-[13px] font-bold ${rising ? "text-green" : "text-danger"}`}>
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
          <p className="px-5 text-[12px] text-muted">
            Курс ЦБ РФ{updated ? ` · обновлён ${DAY.format(updated)}` : ""}
          </p>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
            {/* Три числа в ряд: ближняя динамика, месячная и отклонение от
                обычного. Именно они отвечают на «дорого сейчас или нет». */}
            <div className="flex gap-3 rounded-xl2 border border-border p-3.5">
              <Stat label={`за ${WEEK_DAYS} дней`}><Delta percent={week} /></Stat>
              <Stat label="за месяц"><Delta percent={month} /></Stat>
              <Stat label="к среднему за месяц">
                <Delta percent={stats ? stats.vsAvgPercent : null} />
              </Stat>
            </div>

            {/* Коридор месяца с отметкой сегодня. Показывает то, чего не видно
                из процентов: у верхней мы границы или у нижней. */}
            {stats && stats.max > stats.min && (
              <div className="mt-3 rounded-xl2 border border-border p-3.5">
                <div className="flex items-baseline justify-between text-[12px] font-semibold text-muted">
                  <span>{FORMAT.format(stats.min)}</span>
                  <span className="text-[11px] font-medium">коридор месяца</span>
                  <span>{FORMAT.format(stats.max)}</span>
                </div>
                <div className="relative mt-2 h-1.5 rounded-full bg-mutedbg">
                  <span
                    aria-hidden
                    className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface"
                    style={{ left: `${positionInRange(stats.last, stats.min, stats.max) * 100}%` }}
                  />
                </div>
              </div>
            )}

            <div className="mt-3 rounded-xl2 border border-border p-3.5">
              {history === null ? (
                <div className="skeleton h-[150px] w-full rounded-lg" />
              ) : history.length < 2 ? (
                <p className="text-[13px] text-muted">Пока недостаточно данных для графика.</p>
              ) : (
                <FxRateChart points={history} />
              )}
              {history !== null && history.length >= 2 && history.length < HISTORY_DAYS && (
                <p className="mt-2 text-[12px] text-muted">
                  Копим историю с запуска — график будет за полный месяц позже.
                </p>
              )}
            </div>

            {/* Единственная строка прозы, которая меняет поведение. Всё
                остальное объясняло механику, знать которую необязательно. */}
            <p className="mt-3 text-[13px] leading-[1.45] text-muted">
              Цена фиксируется в момент оформления заявки — ловить удачный курс не нужно.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
