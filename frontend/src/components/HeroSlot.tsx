/** Барабан статусов в шапке главной: режим работы и курс в одном окне.
 *
 *  ===== Почему барабан, а не два чипа рядом =====
 *
 *  Два одинаково ярких факта в ряду конкурируют за внимание и съедают половину
 *  шапки по горизонтали. Здесь они занимают ОДНО место: окно высотой в контрол,
 *  внутри — вертикальная лента, и в кадре всегда ровно один факт.
 *
 *  Была промежуточная версия со стопкой: две карточки друг на друге со сдвигом
 *  и поворотом по X. Выглядело это не глубиной, а двойной экспозицией — нижняя
 *  просвечивала сквозь верхнюю, и «$84,3» читался прямо под «до 21:00». Две
 *  одинаковые по размеру карточки так и будут выглядеть при любом смещении:
 *  приём оказался не тот. Обрезка окна снимает вопрос целиком — просвечивать
 *  нечему.
 *
 *  Тап прокручивает ленту И сразу открывает шторку того, что встало в кадр:
 *  одно движение отвечает и на «покажи подробнее», и на «теперь смотрю сюда».
 *  Разделять эти намерения не нужно — человек тянется сюда узнать, а не менять
 *  порядок фактов.
 *
 *  Левый факт подменяется по приоритету: живая заявка важнее режима работы и
 *  занимает его место. Курс остаётся вторым в любом случае.
 *
 *  ===== Почему статус вообще нужен =====
 *
 *  «Закрыто» без пояснения читается как «магазин не работает», хотя заявку мы
 *  принимаем круглосуточно — очно только выдача. Поэтому статус кликабелен и
 *  объясняет себя (PickupHoursSheet), а не просто гасит настроение в полночь.
 */
import {
  lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
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

/** Сколько едет барабан. Совпадает с --motion-standard: это перестроение
 *  элемента, а не отклик на нажатие. */
const ROLL_MS = 190;

/** Что сейчас в кадре. */
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

  /** Ссылка на ленту. Стили пишем прямо в DOM, минуя React: покадровый
   *  setState на карусели фото уже давал рывки (см. ProductCard). */
  const trackRef = useRef<HTMLSpanElement>(null);
  const progress = useRef(0);
  const cancel = useRef<() => void>(() => {});

  /** Сдвиг ленты: 0 — виден первый факт, 1 — второй.
   *
   *  Покадрово, а не CSS-переходом: этот webview гасит декларативную анимацию
   *  целиком — урок уже дважды оплачен (стекло нижней навигации, проявление
   *  онбординга), см. lib/motion. translateY композиторное, раскладка не
   *  пересчитывается. */
  const paint = useCallback((t: number) => {
    progress.current = t;
    const el = trackRef.current;
    if (el) el.style.transform = `translateY(${(-t * 100).toFixed(3)}%)`;
  }, []);

  // Начальное состояние — до первого кадра.
  //
  // hasRate в зависимостях обязателен: публичный конфиг приходит асинхронно, на
  // первом рендере курса ещё нет и ленты в разметке не существует. Без этой
  // зависимости эффект отработал бы впустую и второй раз не вызвался — лента
  // осталась бы без стилей.
  const hasRate = rate !== null;
  useLayoutEffect(() => { paint(progress.current); }, [paint, hasRate]);
  useEffect(() => () => cancel.current(), []);

  /** Прокрутить барабан и открыть то, что встало в кадр.
   *
   *  При «уменьшить движение» лента переставляется мгновенно: движение уходит,
   *  событие остаётся — то же правило, что во всём проекте. */
  function roll() {
    const next: Front = front === "status" ? "rate" : "status";
    const target = next === "rate" ? 1 : 0;
    cancel.current();
    if (still) paint(target);
    else cancel.current = animateNumber(progress.current, target, ROLL_MS, paint);

    setFront(next);
    if (next === "status" && lead) {
      // У заявки свой экран, шторки нет.
      track("cart_open", { source: "hero_slot_lead" });
      navigate("/requests");
      return;
    }
    track("status_pair_switched", { to: next });
    setSheet(next);
  }

  const statusNode = lead ? (
    <>
      <Icon name="doc" className="h-icon w-icon shrink-0 text-accent" />
      <span className="truncate text-[13px] font-semibold leading-none">{lead.number}</span>
    </>
  ) : (
    <>
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${shop.open ? "bg-green" : "bg-muted"}`}
      />
      <span className="shrink-0 text-[13px] font-medium leading-none">
        {shop.open ? `до ${PICKUP_CLOSE_HOUR}:00` : `с ${PICKUP_OPEN_HOUR}:00`}
      </span>
    </>
  );

  const statusLabel = lead
    ? `Заявка ${lead.number}, ${lead.label}`
    : `Точка выдачи ${shop.open ? "открыта" : "закрыта"}, ${shop.label}`;

  const sheets = (
    <>
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
    </>
  );

  // Курса нет, пока в fx_rate_history нет строк — крутить нечего, остаётся
  // обычный чип. Городить ленту из одного элемента незачем.
  if (!rate) {
    return (
      <div data-collapsing-pretitle className="flex min-w-0 items-center">
        <button
          type="button"
          onClick={() => (lead ? navigate("/requests") : setSheet("status"))}
          aria-label={`${statusLabel}. Подробнее`}
          className="tap flex h-control shrink-0 items-center gap-1.5 rounded-field border border-border bg-surface px-3"
        >
          {statusNode}
        </button>
        {sheets}
      </div>
    );
  }

  return (
    <div data-collapsing-pretitle className="flex min-w-0 items-center">
      <button
        type="button"
        onClick={roll}
        aria-label={
          front === "status"
            ? `${statusLabel}. Нажмите, чтобы посмотреть курс доллара`
            : `Курс доллара ${rate.value} рублей. Нажмите, чтобы посмотреть режим работы`
        }
        className="tap flex h-control shrink-0 items-start overflow-hidden rounded-field border border-border bg-surface px-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {/* Окно высотой в один контрол, внутри — лента из двух фактов подряд.
            Каждый занимает ровно высоту окна, поэтому сдвиг на 100% показывает
            следующий целиком, без подгонки пикселей под шрифт и отступы. */}
        <span ref={trackRef} className="flex w-full flex-col will-change-transform">
          <span className="flex h-control shrink-0 items-center gap-1.5">{statusNode}</span>
          <span className="flex h-control shrink-0 items-center gap-1.5">
            <span className="text-[13px] font-bold leading-none">${rate.value}</span>
            {rate.delta !== null && (
              <span
                className={`text-[11px] font-bold leading-none ${rate.rising ? "text-green" : "text-danger"}`}
              >
                {rate.rising ? "▲" : "▼"}{rate.delta}
              </span>
            )}
          </span>
        </span>
      </button>
      {sheets}
    </div>
  );
}
