/** Левая половина липкой шапки главной в покое.
 *
 *  Место освободилось, когда знак бренда уехал в полосу плавающих кнопок
 *  Telegram. Оно не пустое от лени: мелкий заголовок экрана занимает тот же
 *  слот, но проявляется только по мере таяния крупного, а в покое стоит на
 *  нулевой прозрачности — то есть больше половины полосы была невидимой
 *  заглушкой.
 *
 *  Что здесь стоит, решает СОСТОЯНИЕ человека, а не вкус:
 *
 *  - есть живая заявка — показываем её. У нас весь путь заканчивается словами
 *    «менеджер перезвонит», и первый вопрос вернувшегося — что с ней. Это
 *    самое ценное, что можно сказать в самом заметном месте экрана;
 *  - нет — показываем точку выдачи с живым «открыто/закрыто». У магазина с
 *    самовывозом это следующий по частоте вопрос, и ответ на него не устаревает.
 *
 *  Ни одного нового запроса: заявки уже загружены ради бейджа на вкладке
 *  «Профиль» (store/leadsBadge.ts), часы — константы (lib/pickup.ts).
 *
 *  Слот общий с названием экрана: `data-collapsing-pretitle` ведёт мотор
 *  lib/useCollapsingHeader.ts в противофазе с `data-collapsing-smalltitle`.
 *  Сумма их прозрачностей всегда равна единице — в слоте не бывает ни пусто,
 *  ни двойной яркости.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Icon } from "./icons";
import { track } from "../lib/analytics";
import { PICKUP_PLACE, moscowHour, pickupStatus } from "../lib/pickup";
import { useLeadsBadge } from "../store/leadsBadge";

/** Как часто пересчитываем «открыто/закрыто».
 *
 *  Минута, а не секунда: подпись меняется дважды в сутки, и точность до секунды
 *  здесь никому не нужна — а таймер на каждом кадре стоил бы ре-рендера шапки
 *  на экране, который в это время прокручивают. */
const CLOCK_TICK_MS = 60_000;

export default function HeroSlot() {
  const navigate = useNavigate();
  const latest = useLeadsBadge((s) => s.latest);

  // Час пересчитывается по таймеру, а не берётся один раз при монтировании:
  // приложение живёт в Telegram часами свёрнутым, и вернувшийся в 21:05
  // человек не должен видеть «до 21:00».
  const [hour, setHour] = useState(() => moscowHour(new Date()));
  useEffect(() => {
    const id = setInterval(() => setHour(moscowHour(new Date())), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const shop = useMemo(() => pickupStatus(hour), [hour]);

  const lead = latest;
  const go = () => {
    if (lead) {
      track("cart_open", { source: "hero_slot_lead" });
      navigate("/requests");
      return;
    }
    navigate("/info#contacts");
  };

  return (
    <button
      type="button"
      data-collapsing-pretitle
      onClick={go}
      aria-label={
        lead
          ? `Заявка ${lead.number}, ${lead.label}. Открыть мои заявки`
          : `Точка выдачи ${PICKUP_PLACE}, ${shop.open ? "открыта" : "закрыта"} ${shop.label}. Открыть контакты`
      }
      className="hero-slot tap flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-surface/70 py-1 pl-2 pr-2.5 text-left"
    >
      {lead ? (
        <>
          <Icon name="doc" className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate text-[13px] font-semibold leading-none">{lead.number}</span>
          <span className="shrink-0 text-[13px] leading-none text-accent">{lead.label}</span>
        </>
      ) : (
        <>
          {/* Точка состояния, а не слово «открыто»: слово заняло бы место и не
              сказало бы ничего сверх часа, который всё равно написан рядом.
              Цвет — не единственный признак: подпись «до 21:00» / «с 10:00»
              различает состояния сама по себе, и человек с нарушением
              цветовосприятия читает её так же. */}
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${shop.open ? "bg-green" : "bg-muted"}`}
          />
          <span className="truncate text-[13px] font-semibold leading-none">{PICKUP_PLACE}</span>
          <span className="shrink-0 text-[13px] leading-none text-muted">{shop.label}</span>
        </>
      )}
    </button>
  );
}
