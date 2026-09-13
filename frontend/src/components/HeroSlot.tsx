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
import { forwardRef, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "./icons";
import { useLeadsBadge } from "../store/leadsBadge";
import { usePublicConfig } from "../lib/appConfig";
import { formatFxChip } from "../lib/fxFormat";
import { moscowHour, pickupStatus, PICKUP_CLOSE_HOUR, PICKUP_OPEN_HOUR } from "../lib/pickup";
import { animateNumber, prefersReducedMotion } from "../lib/motion";
import { track } from "../lib/analytics";

const PickupHoursSheet = lazy(() => import("./PickupHoursSheet"));
const FxRateSheet = lazy(() => import("./FxRateSheet"));

/** Как часто пересчитывается московский час. */
const CLOCK_TICK_MS = 60_000;

/** Сколько длится переворот стопки. Совпадает с --motion-standard: это
 *  перестроение элемента, а не отклик на нажатие. */
const FLIP_MS = 190;

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

  /** Ссылки на карточки: стили пишем НАПРЯМУЮ в DOM, минуя React.
   *  Покадровый рендер компонента на каждое значение прогресса — это ровно тот
   *  приём, который на карусели фото уже дал рывки (см. ProductCard). */
  const frontRef = useRef<HTMLSpanElement>(null);
  const backRef = useRef<HTMLSpanElement>(null);
  const progress = useRef(front === "rate" ? 1 : 0);
  const cancel = useRef<() => void>(() => {});

  /** Как выглядит карточка при данной «выдвинутости» вперёд (0 — сзади, 1 —
   *  впереди). Считается покадрово, а не CSS-переходом: этот webview гасит
   *  декларативную анимацию целиком, и transition здесь просто перещёлкивал
   *  состояние — переворота не было видно вовсе (тот же урок, что у стекла
   *  нижней навигации и у проявления онбординга, см. lib/motion).
   *
   *  Пишутся только transform и opacity — композиторные свойства, кадр отдаёт
   *  GPU, раскладка не пересчитывается. */
  const paintCard = useCallback((el: HTMLSpanElement | null, forwardness: number) => {
    if (!el) return;
    const back = 1 - forwardness;
    el.style.opacity = String(0.55 + 0.45 * forwardness);
    el.style.zIndex = forwardness > 0.5 ? "10" : "0";
    el.style.transform = still
      ? ""
      : `translateY(${(back * 7).toFixed(2)}px) scale(${(1 - back * 0.1).toFixed(3)}) rotateX(${(back * 38).toFixed(1)}deg)`;
  }, [still]);

  const paint = useCallback((t: number) => {
    progress.current = t;
    paintCard(frontRef.current, 1 - t);  // статус впереди при t = 0
    paintCard(backRef.current, t);       // курс впереди при t = 1
  }, [paintCard]);

  // Начальное состояние — до первого кадра, иначе обе карточки успевают
  // мигнуть одинаковыми.
  //
  // hasRate в зависимостях обязателен. Публичный конфиг приходит асинхронно:
  // на первом рендере курса ещё нет, компонент уходит в ветку одиночного
  // статуса, и привязывать ссылки не к чему. Стопка появляется ПОЗЖЕ — и без
  // этой зависимости эффект к тому моменту уже отработал, а второй раз не
  // вызывался. Карточки оставались без стилей: до первого тапа стопка
  // выглядела плоской, а первый переворот стартовал из состояния, которого
  // никто не задавал.
  const hasRate = rate !== null;
  useLayoutEffect(() => { paint(progress.current); }, [paint, hasRate]);
  useEffect(() => () => cancel.current(), []);

  /** Один жест: перевернуть стопку и открыть то, что вышло вперёд.
   *
   *  Отдельной кнопки «открыть» нет намеренно. Два действия на одном контроле
   *  человек различать не обязан — он тянется к статусу, чтобы УЗНАТЬ, а не
   *  чтобы поменять порядок карточек.
   */
  function flip() {
    const next: Front = front === "status" ? "rate" : "status";
    cancel.current();
    cancel.current = animateNumber(progress.current, next === "rate" ? 1 : 0, FLIP_MS, paint);

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
        <StackCard ref={frontRef}>{statusNode}</StackCard>
        <StackCard ref={backRef}>
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
 *  Своих состояний у неё нет: прозрачность, поворот и порядок наложения пишет
 *  покадровый мотор родителя прямо в style. Здесь только то, что не меняется
 *  во время движения, — форма, отступы и типографика.
 *
 *  Из-под передней карточки видно нижнюю кромку задней, и по этой кромке сразу
 *  понятно, что под ней что-то есть и стопку можно перевернуть. Без этого
 *  намёка контрол выглядел бы обычной кнопкой, а второй факт был бы спрятан.
 */
const StackCard = forwardRef<HTMLSpanElement, { children: ReactNode }>(
  function StackCard({ children }, ref) {
    return (
      <span
        ref={ref}
        className="pointer-events-none col-start-1 row-start-1 flex h-control items-center justify-center gap-1.5 rounded-field border border-border bg-surface px-3"
      >
        {children}
      </span>
    );
  },
);
