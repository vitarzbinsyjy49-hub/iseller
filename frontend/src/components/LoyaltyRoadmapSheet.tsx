/** Роудмап прокачки аккаунта.
 *
 *  Открывается с экрана «Баллы». Показывает, что появится дальше, — и по тому
 *  же правилу, что роудмап AI: СРОКОВ ЗДЕСЬ НЕТ. Дата — это обещание, а
 *  обещание, которое некому обеспечить, хуже его отсутствия. Порядок отражает
 *  приоритет, не календарь.
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

const STEPS: Step[] = [
  {
    title: "Списание баллов прямо в корзине",
    body:
      "Сейчас баллы списывает менеджер при оформлении сделки. Дальше — галочка " +
      "«оплатить баллами» в самой корзине: сумма пересчитается до отправки заявки.",
    next: true,
  },
  {
    title: "Начисление сразу после подтверждения заказа",
    body:
      "Пока баллы начисляет менеджер после сделки. Когда оплата будет " +
      "фиксироваться в магазине, кэшбек появится на счету автоматически.",
  },
  {
    title: "Уведомление о начислении в Telegram",
    body:
      "Сообщение о том, что баллы пришли, и напоминание, когда их хватает на " +
      "заметную скидку. Тем же каналом, которым магазин уже пишет о статусе заявки.",
  },
  {
    title: "Бонус за первую покупку и в день рождения",
    body:
      "Приветственные баллы новому покупателю и подарок к дате — без условий и " +
      "мелкого шрифта.",
  },
  {
    title: "Ранний доступ и закрытые предложения",
    body:
      "Верхним уровням — предзаказ новинок раньше витрины и цены, которых нет в " +
      "общем каталоге.",
  },
];

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
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Планы магазина
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

            <p className="mt-5 text-[11px] leading-4 text-muted">
              Порядок отражает приоритет — сроков мы намеренно не называем.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
