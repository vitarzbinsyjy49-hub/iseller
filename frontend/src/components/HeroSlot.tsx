/** Левый слот шапки главной.
 *
 *  Показывает ОДНО из двух, по приоритету:
 *
 *  1. Живая заявка — если она есть, это самое важное, что мы можем сказать
 *     человеку в шапке, и никакой статус магазина её не перебивает.
 *  2. Иначе — связь с менеджером и состояние точки выдачи.
 *
 *  Раньше вторым состоянием была пилюля «Горбушка · до 21:00», и она вела в
 *  контакты. Проблема была не в размере: строка отвечала на вопрос, которого
 *  человек не задавал, а на главный — «как спросить живого человека» — не
 *  отвечала вовсе. Теперь на этом месте действие (написать менеджеру), а часы
 *  ужаты до точки состояния, которая раскрывается по нажатию.
 *
 *  Почему статус вообще остался. «Закрыто» без пояснения читается как «магазин
 *  не работает», хотя заявку мы принимаем круглосуточно — очно только выдача.
 *  Поэтому статус кликабелен и объясняет себя (PickupHoursSheet), а не просто
 *  гасит настроение в полночь.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "./icons";
import { useLeadsBadge } from "../store/leadsBadge";
import { usePublicConfig } from "../lib/appConfig";
import { openExternalLink } from "../lib/telegram";
import { animateNumber, prefersReducedMotion } from "../lib/motion";
import { moscowHour, pickupStatus, PICKUP_CLOSE_HOUR, PICKUP_OPEN_HOUR } from "../lib/pickup";
import { track } from "../lib/analytics";

const PickupHoursSheet = lazy(() => import("./PickupHoursSheet"));

/** Как часто пересчитывается московский час. */
const CLOCK_TICK_MS = 60_000;

/** Пауза между пробегами блика по кнопке менеджера. */
const SHEEN_EVERY_MS = 7_000;
/** Длительность одного пробега. */
const SHEEN_MS = 900;

/** Блик по кнопке менеджера — покадрово, а не CSS-анимацией.
 *
 *  Декларативную анимацию этот webview гасит целиком (см. lib/motion), поэтому
 *  «живость» здесь может дать только покадровый мотор. Блик редкий и короткий:
 *  кнопка в шапке видна всё время, и непрерывное движение в ней превратилось бы
 *  в раздражитель, а не в подсказку. При «уменьшить движение» не запускается
 *  вовсе — тогда кнопка просто статична, и это нормальное её состояние.
 */
function useSheen(ref: React.RefObject<HTMLElement>, enabled: boolean) {
  useEffect(() => {
    if (!enabled || prefersReducedMotion()) return;
    let cancelAnim = () => {};
    const run = () => {
      const el = ref.current;
      if (!el) return;
      cancelAnim = animateNumber(0, 1, SHEEN_MS, (t) => {
        // -120% -> 220%: блик заходит слева за краем и уходит за правый.
        el.style.setProperty("--sheen-x", `${-120 + t * 340}%`);
      }, () => el.style.setProperty("--sheen-x", "-120%"));
    };
    const id = setInterval(run, SHEEN_EVERY_MS);
    const first = setTimeout(run, 1200);
    return () => { clearInterval(id); clearTimeout(first); cancelAnim(); };
  }, [ref, enabled]);
}

export default function HeroSlot() {
  const navigate = useNavigate();
  const latest = useLeadsBadge((s) => s.latest);
  const config = usePublicConfig();

  // Час пересчитывается по таймеру, а не берётся один раз при монтировании:
  // приложение живёт в Telegram часами свёрнутым, и вернувшийся в 21:05
  // человек не должен видеть «до 21:00».
  const [hour, setHour] = useState(() => moscowHour(new Date()));
  useEffect(() => {
    const id = setInterval(() => setHour(moscowHour(new Date())), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const shop = useMemo(() => pickupStatus(hour), [hour]);

  const [hoursOpen, setHoursOpen] = useState(false);
  const managerRef = useRef<HTMLButtonElement>(null);
  const lead = latest;
  useSheen(managerRef, !lead);

  if (lead) {
    return (
      <button
        type="button"
        data-collapsing-pretitle
        onClick={() => { track("cart_open", { source: "hero_slot_lead" }); navigate("/requests"); }}
        aria-label={`Заявка ${lead.number}, ${lead.label}. Открыть мои заявки`}
        className="hero-slot tap flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-surface/70 py-1 pl-2 pr-2.5 text-left"
      >
        <Icon name="doc" className="h-4 w-4 shrink-0 text-accent" />
        <span className="truncate text-[13px] font-semibold leading-none">{lead.number}</span>
        <span className="shrink-0 text-[13px] leading-none text-accent">{lead.label}</span>
      </button>
    );
  }

  return (
    <div data-collapsing-pretitle className="flex min-w-0 items-center gap-1.5">
      {/* Действие — первым и шире: за ним человек сюда и тянется. */}
      <button
        ref={managerRef}
        type="button"
        onClick={() => {
          // Ссылки нет (конфиг не доехал) — уводим в контакты, а не в никуда.
          if (!openExternalLink(config.manager_retail_url)) navigate("/info#contacts");
        }}
        aria-label="Написать менеджеру в Telegram"
        className="hero-manager tap relative flex h-7 min-w-0 items-center gap-1.5 overflow-hidden rounded-full border border-accent/25 bg-accent/10 pl-2 pr-2.5 text-left"
      >
        <Icon name="chat" className="h-4 w-4 shrink-0 text-accent" />
        <span className="truncate text-[13px] font-semibold leading-none text-accent">Менеджер</span>
      </button>

      {/* Статус — вторым и компактно: он справка, а не действие. Точка плюс
          время; слово «открыто» заняло бы место и не добавило смысла к часу. */}
      <button
        type="button"
        onClick={() => setHoursOpen(true)}
        aria-label={`Точка выдачи ${shop.open ? "открыта" : "закрыта"}, ${shop.label}. Подробнее`}
        className="tap flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface/70 pl-2 pr-2.5"
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${shop.open ? "bg-green" : "bg-muted"}`}
        />
        <span className="shrink-0 text-[13px] leading-none text-muted">
          {shop.open ? `до ${PICKUP_CLOSE_HOUR}:00` : `с ${PICKUP_OPEN_HOUR}:00`}
        </span>
      </button>

      {hoursOpen && (
        <Suspense fallback={null}>
          <PickupHoursSheet open={shop.open} onClose={() => setHoursOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
