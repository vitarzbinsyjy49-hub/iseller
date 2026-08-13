/** Инфо-блок «о сервисе» — снимает риск квалификации как «дистанционной
 *  торговли»: сделка (оплата, передача товара) идёт очно, а не через бота или
 *  приложение. Открывается неяркой ссылкой в самом низу главной.
 *
 *  Шелл переиспользуется (`SheetShell` из ScenarioSheet), как и у остальных
 *  простых инфо-шитов (BetaRoadmapSheet, AiRoadmapSheet).
 */
import { SheetShell } from "./ScenarioSheet";
import { Icon } from "./icons";

export default function AboutServiceSheet({ onClose }: { onClose: () => void }) {
  return (
    <SheetShell onClose={onClose} labelledBy="about-service-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start gap-3 px-5 pb-3 pt-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
              <Icon name="info" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="about-service-title" className="text-[17px] font-bold leading-6">
                О сервисе
              </h2>
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
            <p className="text-[13.5px] leading-[1.5] text-text">
              AI Seller — информационный ИИ-каталог, не интернет-магазин. Бот и
              приложение помогают подобрать технику и оформить заявку; сама
              сделка — оплата и передача товара — проходит очно, наличными,
              при получении. Онлайн-оплаты и дистанционной продажи здесь нет.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
