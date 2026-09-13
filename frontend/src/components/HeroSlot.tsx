/** Пара статусов в шапке главной: состояние магазина и курс.
 *
 *  ===== Почему пара, а не два чипа рядом =====
 *
 *  Два одинаково ярких факта в одном ряду конкурируют за внимание и не дают
 *  глазу точки входа: оба что-то сообщают, оба нажимаются, оба выглядят
 *  одинаково важными. Поэтому у них есть передний и задний план: впереди тот,
 *  которым сейчас интересуются, второй приглушён и отодвинут вглубь.
 *
 *  Тап по заднему выводит его вперёд И сразу открывает его шторку — одно
 *  движение отвечает и на «покажи подробнее», и на «теперь смотрю сюда».
 *  Разделять эти два намерения не нужно: человек не переключает план ради
 *  переключения.
 *
 *  Левый элемент пары подменяется по приоритету: живая заявка важнее режима
 *  работы и занимает его место. Курс при этом остаётся вторым в любом случае.
 *
 *  ===== Почему статус вообще нужен =====
 *
 *  «Закрыто» без пояснения читается как «магазин не работает», хотя заявку мы
 *  принимаем круглосуточно — очно только выдача. Поэтому статус кликабелен и
 *  объясняет себя (PickupHoursSheet), а не просто гасит настроение в полночь.
 *
 *  Кнопка менеджера раньше стояла здесь же и уехала в строку услуг под афишей:
 *  связь с менеджером — услуга, а не статус. Рядом с часами работы она
 *  смотрелась как «Позвонить» рядом с «Открыто до 21:00» на двери магазина —
 *  вроде и о том же месте, но про разное.
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "./icons";
import { useLeadsBadge } from "../store/leadsBadge";
import { usePublicConfig } from "../lib/appConfig";
import { formatFxChip } from "../lib/fxFormat";
import { moscowHour, pickupStatus, PICKUP_CLOSE_HOUR, PICKUP_OPEN_HOUR } from "../lib/pickup";
import { prefersReducedMotion } from "../lib/motion";
import { track } from "../lib/analytics";

const PickupHoursSheet = lazy(() => import("./PickupHoursSheet"));
const FxRateSheet = lazy(() => import("./FxRateSheet"));

/** Как часто пересчитывается московский час. */
const CLOCK_TICK_MS = 60_000;

/** Что сейчас на переднем плане. */
type Front = "status" | "rate";

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

  const [front, setFront] = useState<Front>("status");
  const [sheet, setSheet] = useState<Front | null>(null);

  const rate = formatFxChip(config.usd_rate);
  const lead = latest;
  const still = prefersReducedMotion();

  /** Вывести вперёд и открыть. Одно намерение — один обработчик. */
  function pick(which: Front) {
    if (which !== front) track("status_pair_switched", { to: which });
    setFront(which);
    setSheet(which);
  }

  /** Один жест: перевернуть стопку и открыть то, что вышло вперёд.
   *
   *  Отдельной кнопки «открыть» нет намеренно. Два действия на одном контроле
   *  (переключить / раскрыть) человек различать не обязан — он тянется к
   *  статусу, чтобы УЗНАТЬ, а не чтобы поменять порядок карточек. Поэтому
   *  переворот и раскрытие — одно движение, а вторым тапом возвращается первая.
   */
  function flip() {
    const next: Front = front === "status" ? "rate" : "status";
    // Заявка живёт на своём экране, шторки у неё нет: если вперёд выходит она,
    // просто уводим туда.
    if (next === "status" && lead) {
      setFront(next);
      track("cart_open", { source: "hero_slot_lead" });
      navigate("/requests");
      return;
    }
    track("status_pair_switched", { to: next });
    setFront(next);
    setSheet(next);
  }

  const statusNode = lead ? (
    <>
      <Icon name="doc" className="h-icon w-icon shrink-0 text-accent" />
      <span className="truncate text-[13px] font-semibold leading-none">{lead.number}</span>
    </>
  ) : (
    <>
      <span aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${shop.open ? "bg-green" : "bg-muted"}`} />
      <span className="shrink-0 text-[13px] font-medium leading-none">
        {shop.open ? `до ${PICKUP_CLOSE_HOUR}:00` : `с ${PICKUP_OPEN_HOUR}:00`}
      </span>
    </>
  );

  const statusLabel = lead
    ? `Заявка ${lead.number}, ${lead.label}`
    : `Точка выдачи ${shop.open ? "открыта" : "закрыта"}, ${shop.label}`;

  // Курса нет, пока в fx_rate_history нет строк. Тогда стопки не существует —
  // остаётся один статус, и переворачивать нечего.
  if (!rate) {
    return (
      <div data-collapsing-pretitle className="flex min-w-0 items-center">
        <button type="button" onClick={() => (lead ? navigate("/requests") : setSheet("status"))}
          aria-label={`${statusLabel}. Подробнее`}
          className="tap flex h-control shrink-0 items-center gap-1.5 rounded-field border border-border bg-surface px-3">
          {statusNode}
        </button>
        {sheet === "status" && (
          <Suspense fallback={null}>
            <PickupHoursSheet open={shop.open} onClose={() => setSheet(null)} />
          </Suspense>
        )}
      </div>
    );
  }

  return (
    <div data-collapsing-pretitle className="flex min-w-0 items-center">
      <button
        type="button"
        onClick={flip}
        aria-label={
          front === "status"
            ? `${statusLabel}. Нажмите, чтобы посмотреть курс доллара`
            : `Курс доллара ${rate.value} рублей. Нажмите, чтобы посмотреть режим работы`
        }
        // grid со всеми детьми в одной ячейке: стопка занимает место ШИРОЧАЙШЕЙ
        // из карточек и ровно одну высоту контрола, сколько бы их ни было.
        // Раньше эти же два факта стояли рядом и съедали половину шапки.
        //
        // perspective включает настоящую глубину: без неё rotateX даёт плоское
        // сжатие по вертикали, и переворот читается как «схлопнулось», а не как
        // «повернулось».
        className="stack-flip tap relative grid h-control shrink-0 items-center outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <StackCard front={front === "status"} still={still}>{statusNode}</StackCard>
        <StackCard front={front === "rate"} still={still}>
          <span className="text-[13px] font-bold leading-none">${rate.value}</span>
          {rate.delta !== null && (
            <span className={`text-[11px] font-bold leading-none ${rate.rising ? "text-green" : "text-danger"}`}>
              {rate.rising ? "▲" : "▼"}{rate.delta}
            </span>
          )}
        </StackCard>
      </button>

      {sheet === "status" && (
        <Suspense fallback={null}>
          <PickupHoursSheet open={shop.open} onClose={() => setSheet(null)} />
        </Suspense>
      )}
      {sheet === "rate" && config.usd_rate && (
        <Suspense fallback={null}>
          <FxRateSheet usdRate={config.usd_rate} onClose={() => setSheet(null)} />
        </Suspense>
      )}
    </div>
  );
}

/** Карточка в стопке. Обе лежат в одной ячейке grid, одна поверх другой.
 *
 *  Передняя — плоско и непрозрачно. Задняя повёрнута по X, отодвинута вглубь и
 *  приглушена: из-под передней видно её нижнюю кромку, и по этой кромке сразу
 *  понятно, что под ней что-то есть и стопку можно перевернуть. Без этого
 *  намёка контрол выглядел бы обычной кнопкой, и второй факт был бы спрятан.
 *
 *  Анимируются только transform и opacity — оба композиторные, кадр отдаёт GPU.
 *  Это важно здесь особенно: рядом сама едет лента баннеров, и переворот не
 *  должен отбирать у неё главный поток.
 *
 *  При «уменьшить движение» поворота нет — остаются прозрачность и подложка.
 *  Настройка убирает движение, а не событие: какая карточка впереди, по-прежнему
 *  видно (то же правило, что в lib/motion.ts).
 */
function StackCard({
  front, still, children,
}: {
  front: boolean;
  still: boolean;
  children: ReactNode;
}) {
  const base =
    "pointer-events-none col-start-1 row-start-1 flex h-control items-center justify-center gap-1.5 " +
    "rounded-field border px-3 transition-[opacity,transform,background-color,border-color] " +
    "duration-standard ease-premium";
  const state = front
    ? "z-10 border-border bg-surface text-text opacity-100"
    : "border-border/70 bg-mutedbg text-muted opacity-70 " +
      (still ? "" : "[transform:translateY(7px)_scale(.9)_rotateX(38deg)]");

  return <span className={`${base} ${state}`}>{children}</span>;
}
