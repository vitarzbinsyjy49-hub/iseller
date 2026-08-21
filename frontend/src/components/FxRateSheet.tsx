/** Шторка «Курс и цены» — открывается тапом по FxRateChip на главной.
 *
 *  Текущее значение/дельта приходят пропом (уже есть из /config/public,
 *  повторно не грузим). История для графика — лениво при открытии, не на
 *  каждой загрузке главной (см. спеку, GET /api/fx/history?days=30).
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toSparklinePoints } from "../lib/sparkline";
import { SheetShell } from "./ScenarioSheet";

const FORMAT = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HISTORY_DAYS = 30;

type HistoryPoint = { date: string; value: number };

const FAQ: { q: string; a: string }[] = [
  {
    q: "Цены меняются каждый день вслед за курсом?",
    a: "Нет — мы пересматриваем цены при заметных движениях курса, не ежедневно.",
  },
  {
    q: "Курс вырос — моя оформленная заявка подорожает?",
    a: "Нет, цена фиксируется в момент оформления заявки.",
  },
  {
    q: "Откуда берётся курс?",
    a: "Официальный курс ЦБ РФ, обновляется раз в сутки.",
  },
];

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

  const rising = usdRate.delta >= 0;
  const deltaFormatted = FORMAT.format(Math.abs(usdRate.delta));
  // Проверяем именно ОТФОРМАТИРОВАННУЮ строку, а не числовой порог 0.05 из
  // fxFormat.ts (тот подобран под ОДИН знак после запятой в чипе) — здесь
  // FORMAT даёт ДВА знака, и порог 0.05 спрятал бы настоящие «0,02»-«0,04».
  // Гарантированный случай остаётся тем же: делта ровно 0 в день запуска.
  const deltaRoundsToZero = deltaFormatted === "0,00";
  const points = history ? toSparklinePoints(history.map((h) => h.value), 300, 70) : "";

  return (
    <SheetShell onClose={onClose} labelledBy="fx-rate-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start justify-between px-5 pb-2 pt-4">
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
                strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <p className="px-5 text-[12px] text-muted">Курс ЦБ РФ · обновляется ежедневно</p>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
            <div>
              <h4 className="text-[13px] font-bold uppercase tracking-[0.04em] text-muted">
                Почему это влияет на цены
              </h4>
              <p className="mt-2 text-[14px] leading-[1.5] text-text">
                Часть техники — iPhone, MacBook, PlayStation — мы везём из Кореи и
                Гонконга за доллары. Когда курс растёт, закупка дорожает, и цена на
                складе может измениться. Мы стараемся не менять её каждый день, но
                заметный скачок курса обычно виден и в цене.
              </p>
            </div>

            <div className="mt-5">
              <h4 className="text-[13px] font-bold uppercase tracking-[0.04em] text-muted">
                Курс за {HISTORY_DAYS} дней
              </h4>
              <div className="mt-2 rounded-xl2 border border-border p-3.5">
                {history === null ? (
                  <div className="skeleton h-[70px] w-full rounded-lg" />
                ) : history.length < 2 ? (
                  <p className="text-[13px] text-muted">Пока недостаточно данных для графика.</p>
                ) : (
                  <svg viewBox="0 0 300 70" width="100%" height="70">
                    <polyline
                      fill="none" stroke="rgb(var(--app-accent))" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round" points={points}
                    />
                  </svg>
                )}
                {history !== null && history.length >= 2 && history.length < HISTORY_DAYS && (
                  <p className="mt-2 text-[12px] text-muted">
                    Копим историю с запуска — график будет за полный месяц позже.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-5 flex gap-2.5 rounded-xl2 bg-mutedbg p-3.5">
              <span className="text-[18px]">💡</span>
              <p className="text-[14px] leading-[1.45] text-text">
                Если планируете покупку — цена на складе фиксируется в момент
                оформления заявки, а не пересчитывается каждый день. Не нужно ловить
                «удачный курс».
              </p>
            </div>

            <div className="mt-5">
              <h4 className="text-[13px] font-bold uppercase tracking-[0.04em] text-muted">
                Частые вопросы
              </h4>
              {FAQ.map((item, i) => (
                <div key={item.q} className={`py-3 ${i > 0 ? "border-t border-border" : ""}`}>
                  <p className="text-[14px] font-semibold text-text">{item.q}</p>
                  <p className="mt-1 text-[13.5px] leading-[1.45] text-muted">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </SheetShell>
  );
}
