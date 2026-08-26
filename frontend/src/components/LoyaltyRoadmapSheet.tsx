/** Роудмап прокачки аккаунта.
 *
 *  Открывается с экрана «Баллы». Своего списка у шторки нет: она фильтрует
 *  общий роудмап (`lib/roadmap.ts`) по треку "loyalty". Раньше список жил здесь
 *  копией и уже разошёлся с роудмапом приложения — один и тот же пункт про
 *  списание баллов описывался в двух местах разными словами.
 *
 *  Шелл переиспользуется (`SheetShell` из ScenarioSheet): второй шелл означал бы
 *  вторую ловушку фокуса и вторую блокировку скролла, которые расходятся молча.
 */
import { SheetShell } from "./ScenarioSheet";
import RoadmapSteps from "./RoadmapSteps";
import { Icon } from "./icons";

export default function LoyaltyRoadmapSheet({ onClose }: { onClose: () => void }) {
  return (
    <SheetShell onClose={onClose} labelledBy="loyalty-roadmap-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start gap-3 px-5 pb-3 pt-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
              <Icon name="sparkles" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="loyalty-roadmap-title" className="text-[17px] font-bold leading-6">
                Что будет дальше
              </h2>
              <p className="mt-0.5 text-[12px] leading-4 text-muted">
                Как будет развиваться программа лояльности
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

          {/* Как это работает сейчас — до планов. Обещать будущее, не объяснив
              настоящее, значит просить доверия авансом. */}
          <div className="mx-5 rounded-field bg-mutedbg px-3.5 py-3">
            <p className="text-[12px] font-semibold">Как это работает сейчас</p>
            <p className="mt-1 text-[12px] leading-[1.45] text-muted">
              Баллы начисляет менеджер после покупки — по ставке вашего уровня.
              Один балл равен рублю скидки на следующую покупку: скажите менеджеру,
              что хотите списать, и он уменьшит сумму.
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
              Планы магазина
            </p>

            <RoadmapSteps track="loyalty" />

            <p className="mt-5 text-[11px] leading-4 text-muted">
              Месяц — это план, а не гарантия: что-то может сдвинуться.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
