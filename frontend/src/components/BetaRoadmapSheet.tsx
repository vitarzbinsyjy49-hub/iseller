/** Что значит «бета» и что будет дальше.
 *
 *  Открывается по чипу BETA рядом с логотипом на главной. Правило то же, что у
 *  роудмапов AI и баллов: СРОКОВ ЗДЕСЬ НЕТ. Дата — это обещание, а обещание,
 *  которое некому обеспечить, хуже его отсутствия. Порядок отражает приоритет.
 *
 *  Сначала — что уже работает. Пометка «бета» без этого читается как «тут пока
 *  ничего не работает», хотя магазин принимает заявки по-настоящему.
 *
 *  Шелл переиспользуется (`SheetShell` из ScenarioSheet): второй шелл означал бы
 *  вторую ловушку фокуса и вторую блокировку скролла, которые расходятся молча.
 */
import { SheetShell } from "./ScenarioSheet";
import { Icon } from "./icons";

type Step = {
  title: string;
  body: string;
  /** Ближайший шаг — ровно один. Двух «следующих» не бывает. */
  next?: boolean;
};

const WORKS: string[] = [
  "Каталог с фото, характеристиками и ценами из наличия",
  "AI-подбор: опишите задачу и бюджет — предложит варианты",
  "Корзина и заявка: менеджер подтверждает наличие и итоговую сумму",
  "Избранное, история просмотров и статусы заявок",
];

const STEPS: Step[] = [
  {
    title: "Оплата онлайн",
    body:
      "Сейчас оплата наличными при получении. Дальше — оплата картой и СБП " +
      "прямо в приложении, со ссылкой от менеджера после подтверждения заказа.",
    next: true,
  },
  {
    title: "Отслеживание доставки",
    body:
      "Трек-номер СДЭК в заявке и уведомление в Telegram, когда посылка " +
      "меняет статус. Пока трек присылает менеджер вручную.",
  },
  {
    title: "Списание баллов в корзине",
    body:
      "Баллы уже начисляются, но списывает их менеджер. Появится галочка " +
      "«оплатить баллами» с пересчётом суммы до отправки заявки.",
  },
  {
    title: "Больше товаров и брендов",
    body:
      "Каталог пополняется. Если нужной модели нет — напишите менеджеру: " +
      "привозим под заказ и добавляем в каталог то, что спрашивают чаще.",
  },
];

export default function BetaRoadmapSheet({ onClose }: { onClose: () => void }) {
  return (
    <SheetShell onClose={onClose} labelledBy="beta-roadmap-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start gap-3 px-5 pb-3 pt-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
              <Icon name="sparkles" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="beta-roadmap-title" className="text-[17px] font-bold leading-6">
                АйСеллер в бета-версии
              </h2>
              <p className="mt-0.5 text-[12px] leading-4 text-muted">
                Магазин работает по-настоящему, приложение ещё растёт
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

          {/* Сначала настоящее, потом планы: «бета» без этого абзаца читается
              как предупреждение «ничего не работает». */}
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
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Что появится дальше
            </p>

            <ol className="mt-3 space-y-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                      step.next ? "bg-accent text-white" : "bg-accent/10 text-accent"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 text-[14px] font-semibold leading-5">
                      {step.title}
                      {step.next && (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
                          следующий
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-[12.5px] leading-[1.45] text-muted">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <p className="mt-5 text-[12px] leading-4 text-muted">
              Порядок отражает приоритет — сроков мы намеренно не называем.
              Нашли ошибку или неудобство? Напишите менеджеру, это лучший способ
              повлиять на список выше.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
