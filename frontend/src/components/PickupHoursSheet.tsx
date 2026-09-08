/** Что значит «закрыто» у точки выдачи.
 *
 *  Статус в шапке отвечает на вопрос «успею ли забрать сегодня», и без
 *  пояснения он читается шире, чем есть: закрытая точка выглядит как закрытый
 *  магазин, хотя заявку мы принимаем круглосуточно — очно только выдача.
 *  Человек, открывший приложение в полночь, не должен уйти, решив, что сейчас
 *  ничего сделать нельзя.
 *
 *  Шелл переиспользуется (`SheetShell` из ScenarioSheet), как у остальных
 *  простых инфо-шитов (AboutServiceSheet, AiRoadmapSheet).
 */
import { SheetShell } from "./ScenarioSheet";
import { Icon } from "./icons";
import { PICKUP_ADDRESS, PICKUP_HOURS, PICKUP_OPEN_HOUR } from "../lib/pickup";

export default function PickupHoursSheet({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  return (
    <SheetShell onClose={onClose} labelledBy="pickup-hours-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start gap-3 px-5 pb-3 pt-4">
            <span
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-field ${
                open ? "bg-green/10 text-green" : "bg-mutedbg text-muted"
              }`}
            >
              <Icon name="store" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="pickup-hours-title" className="text-[17px] font-bold leading-6">
                {open ? "Сейчас открыто" : "Сейчас закрыто"}
              </h2>
              <p className="mt-0.5 text-[13px] leading-5 text-muted">
                {PICKUP_ADDRESS} · ежедневно {PICKUP_HOURS}
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

          <div className="px-5 pb-6 pt-1">
            {/* Главное сообщение — первым и в закрытом состоянии тоже: заявку
                принимаем всегда, закрыты только двери. */}
            <p className="text-[13.5px] leading-[1.5] text-text">
              {open
                ? "Оформляйте заявку — заберёте сегодня, точка работает до конца дня."
                : `Заявку примем прямо сейчас, в любое время: заказ уйдёт менеджеру и
                   будет ждать вас. Забрать или получить доставку можно будет
                   с ${PICKUP_OPEN_HOUR}:00.`}
            </p>
            <p className="mt-3 text-[13.5px] leading-[1.5] text-muted">
              Технику проверяем при вас, оплата после проверки. Доставка по Москве
              курьером, по России — СДЭК.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
