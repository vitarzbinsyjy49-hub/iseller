/** Роудмап AI-подбора.
 *
 *  Открывается по бейджу «Powered by Claude» на экране AI. Показывает, куда
 *  движется помощник магазина, — и заодно честно объясняет, чего он НЕ делает.
 *
 *  Все пункты — планы МАГАЗИНА, а не Anthropic. Своего списка у шторки нет:
 *  она фильтрует общий роудмап (`lib/roadmap.ts`) по треку "ai", иначе один и
 *  тот же пункт снова начнёт жить в двух местах разными словами.
 */
import { SheetShell } from "./ScenarioSheet";
import RoadmapSteps from "./RoadmapSteps";
import { ClaudeMark, CLAUDE_ORANGE } from "./ClaudeMark";

export default function AiRoadmapSheet({ model, onClose }: {
  model?: string;
  onClose: () => void;
}) {
  return (
    <SheetShell onClose={onClose} labelledBy="ai-roadmap-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start gap-3 px-5 pb-3 pt-4">
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field"
              style={{ backgroundColor: `${CLAUDE_ORANGE}1a` }}
            >
              <ClaudeMark className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="ai-roadmap-title" className="text-[17px] font-bold leading-6">
                AI-подбор работает на Claude
              </h2>
              <p className="mt-0.5 text-[12px] leading-4 text-muted">
                {model ? `Модель ${model} от Anthropic` : "Модель от Anthropic"}
              </p>
            </div>
            <button
              onClick={() => close()}
              aria-label="Закрыть"
              className="tap -mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mutedbg"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {/* Как это устроено — до планов. Обещать будущее, не объяснив настоящее,
              значит просить доверия авансом. */}
          <div className="mx-5 rounded-field bg-mutedbg px-3.5 py-3">
            <p className="text-[12px] font-semibold">Как это устроено</p>
            <p className="mt-1 text-[12px] leading-[1.45] text-muted">
              Товары и цены модель не придумывает: она выбирает из того, что backend
              нашёл в каталоге. Наличие и цену вы видите те же, что в карточке.
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
              Что будет дальше
            </p>

            <RoadmapSteps track="ai" accentColor={CLAUDE_ORANGE} />

            <p className="mt-5 text-[11px] leading-4 text-muted">
              Планы магазина, а не Anthropic. Месяц — это план, а не гарантия.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
