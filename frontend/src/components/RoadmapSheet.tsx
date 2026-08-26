/** Что уже работает и что будет дальше — общий роудмап приложения.
 *
 *  Пришёл на смену BetaRoadmapSheet. Слово «бета» из продукта уходит вместе со
 *  снятием беты 27 августа, а список планов остаётся нужен и после запуска —
 *  поэтому шторка живёт не на чипе главной, а строкой в профиле.
 *
 *  Пункты берутся из `lib/roadmap.ts`: своего списка у шторки больше нет.
 *
 *  Сначала — что уже работает. Роудмап без этого абзаца читается как «тут пока
 *  ничего не готово», хотя магазин принимает заявки по-настоящему.
 *
 *  Шелл переиспользуется (`SheetShell` из ScenarioSheet): второй шелл означал бы
 *  вторую ловушку фокуса и вторую блокировку скролла, которые расходятся молча.
 */
import { SheetShell } from "./ScenarioSheet";
import RoadmapSteps from "./RoadmapSteps";
import { Icon } from "./icons";

const WORKS: string[] = [
  "Каталог с фото, характеристиками и ценами из наличия",
  "AI-подбор: опишите задачу и бюджет — предложит варианты",
  "Корзина и заявка: менеджер подтверждает наличие и итоговую сумму",
  "Самовывоз из точки выдачи и проверка товара на месте",
  "Избранное, история просмотров и статусы заявок",
];

export default function RoadmapSheet({ onClose }: { onClose: () => void }) {
  return (
    <SheetShell onClose={onClose} labelledBy="roadmap-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start gap-3 px-5 pb-3 pt-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
              <Icon name="sparkles" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="roadmap-title" className="text-[17px] font-bold leading-6">
                Что будет дальше
              </h2>
              <p className="mt-0.5 text-[12px] leading-4 text-muted">
                Магазин работает, приложение продолжает расти
              </p>
            </div>
            <button
              onClick={() => close()}
              aria-label="Закрыть"
              className="tap -mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted outline-none hover:bg-mutedbg focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon name="close" className="h-4 w-4" strokeWidth={2.2} />
            </button>
          </div>

          <div className="mx-5 rounded-field bg-mutedbg px-3.5 py-3">
            <p className="text-[12px] font-semibold">Что уже работает</p>
            <ul className="mt-1.5 space-y-1">
              {WORKS.map((line) => (
                <li key={line} className="flex gap-2 text-[12px] leading-[1.45] text-muted">
                  <Icon name="check" className="mt-[3px] h-3.5 w-3.5 shrink-0 text-green" strokeWidth={2.6} />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
              Планы магазина
            </p>

            <RoadmapSteps track="app" />

            <p className="mt-5 text-[12px] leading-4 text-muted">
              Месяц — это план, а не гарантия: что-то может сдвинуться. Нашли
              ошибку или неудобство? Напишите менеджеру — это лучший способ
              повлиять на список выше.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
