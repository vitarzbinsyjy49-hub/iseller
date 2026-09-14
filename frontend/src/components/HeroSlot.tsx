/** Статусная строка главной: режим работы и курс. Оба видны всегда.
 *
 *  ===== Почему строка, а не чипы, стопка или барабан =====
 *
 *  Через всё это я прошёл, и все три варианта провалились по одной причине: я
 *  делал из двух фактов ЭЛЕМЕНТЫ УПРАВЛЕНИЯ. Два чипа по 44px съедали половину
 *  шапки. Стопка со сдвигом показывала нижнюю карточку сквозь верхнюю —
 *  двойная экспозиция вместо глубины. Барабан прятал один факт за тапом.
 *
 *  Ошибка была в посылке. Это не кнопки. Это статус: на него бросают взгляд,
 *  а не нажимают ради действия. Прятать половину статуса, чтобы сэкономить
 *  место, — значит заставить человека работать ради того, что должно просто
 *  быть видно.
 *
 *  Строка текста без подложек решает всё сразу: оба факта на месте, высота
 *  22px вместо 44 (то есть ДЕШЕВЛЕ одного чипа), и из шапки уходят две формы —
 *  система материалов от этого только выигрывает.
 *
 *  ===== Почему всё-таки нажимается =====
 *
 *  «Закрыто» без пояснения читается как «магазин не работает», хотя заявку мы
 *  принимаем круглосуточно — очно только выдача. А за курсом стоит объяснение,
 *  почему цены меняются. Оба факта обязаны уметь себя раскрыть.
 *
 *  Признак нажимаемости — шеврон, тот же, что у обещаний под афишей: в этом
 *  интерфейсе он значит «раскроется ещё один слой». Голый текст без единого
 *  признака был бы перебором в другую сторону: у надписи нет ни границы, ни
 *  фона, ни подчёркивания, и глазу нечем отличить «нажми» от «прочитай».
 *
 *  Зона касания добирается до нормы 44px псевдоэлементом (.tap-area-control),
 *  как у кнопки ИИ внутри поля поиска: расти вширь строке некуда, а промах
 *  мимо неё недопустим.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
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

type Sheet = "status" | "rate";

/** Дыхание зелёной точки: сколько гаснет, сколько разгорается и сколько стоит
 *  на месте между вдохами. Медленно намеренно — точка сообщает «работаем прямо
 *  сейчас», а не требует внимания. Быстрое мигание в углу экрана превращается в
 *  раздражитель за минуту. */
const BREATH_DOWN_MS = 900;
const BREATH_UP_MS = 900;
const BREATH_PAUSE_MS = 1_400;

/** Медленное дыхание индикатора, покадрово.
 *
 *  CSS-анимация здесь не годится по той же причине, что и везде в проекте: этот
 *  webview гасит декларативную анимацию целиком (см. lib/motion).
 *
 *  Дышит ТОЛЬКО когда открыто. Это не украшение: движение значит «сейчас
 *  работаем», и пульсирующая точка у закрытой точки выдачи говорила бы
 *  обратное тому, что написано рядом.
 *
 *  При «уменьшить движение» точка просто горит. Здесь это правильный отказ, а
 *  не потеря события: сам факт «открыто/закрыто» несут цвет и подпись, дыхание
 *  ничего не добавляет к смыслу. */
function useBreathing(ref: React.RefObject<HTMLElement>, alive: boolean) {
  useEffect(() => {
    if (!alive || prefersReducedMotion()) return;
    let cancel = () => {};
    let timer = 0;
    let stopped = false;

    const set = (v: number) => { if (ref.current) ref.current.style.opacity = String(v); };
    const breathe = () => {
      if (stopped) return;
      cancel = animateNumber(1, 0.32, BREATH_DOWN_MS, set, () => {
        if (stopped) return;
        cancel = animateNumber(0.32, 1, BREATH_UP_MS, set, () => {
          if (stopped) return;
          timer = window.setTimeout(breathe, BREATH_PAUSE_MS);
        });
      });
    };
    breathe();
    return () => {
      stopped = true;
      cancel();
      window.clearTimeout(timer);
      if (ref.current) ref.current.style.opacity = "";
    };
  }, [ref, alive]);
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

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const rate = formatFxChip(config.usd_rate);
  const lead = latest;
  const dotRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  /** Откуда свисает шторка — нижняя кромка этой самой строки, замеренная в
   *  момент открытия. Не константа: строка уезжает при прокрутке вместе с
   *  шапкой, и высота выреза Telegram у разных клиентов разная. */
  const [anchorTopPx, setAnchorTopPx] = useState(0);

  function openSheet(which: Sheet) {
    const r = rowRef.current?.getBoundingClientRect();
    setAnchorTopPx(r ? Math.round(r.bottom + 8) : 0);
    setSheet(which);
  }
  useBreathing(dotRef, shop.open && !lead);

  return (
    <div
      ref={rowRef}
      data-collapsing-pretitle
      className="flex min-w-0 shrink items-center gap-2 overflow-hidden text-[12.5px] leading-none"
    >
      {/* Живая заявка важнее режима работы и занимает его место: если она есть,
          это самое важное, что мы можем сказать человеку в шапке. */}
      {lead ? (
        <StatusItem
          onClick={() => { track("cart_open", { source: "hero_slot_lead" }); navigate("/requests"); }}
          ariaLabel={`Заявка ${lead.number}, ${lead.label}. Открыть мои заявки`}
        >
          <Icon name="doc" className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="truncate font-semibold text-text">{lead.number}</span>
          <span className="shrink-0 text-accent">{lead.label}</span>
        </StatusItem>
      ) : (
        <StatusItem
          onClick={() => openSheet("status")}
          ariaLabel={`Точка выдачи ${shop.open ? "открыта" : "закрыта"}, ${shop.label}. Подробнее`}
        >
          <span
            ref={dotRef}
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${shop.open ? "bg-green" : "bg-muted"}`}
          />
          <span className="shrink-0 font-medium text-text">
            {shop.open ? `до ${PICKUP_CLOSE_HOUR}:00` : `с ${PICKUP_OPEN_HOUR}:00`}
          </span>
        </StatusItem>
      )}

      {/* Курса нет, пока в fx_rate_history нет строк — тогда нет и разделителя.
          Точка, а не вертикальная черта: черта — это ещё одна форма, а строке
          хватает паузы между фактами. */}
      {rate && (
        <>
          <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-border" />
          <StatusItem
            onClick={() => openSheet("rate")}
            ariaLabel={`Курс доллара ${rate.value} рублей. Подробнее`}
          >
            <span className="shrink-0 font-bold text-text">${rate.value}</span>
            {rate.delta !== null && (
              <span className={`shrink-0 text-[11px] font-bold ${rate.rising ? "text-green" : "text-danger"}`}>
                {rate.rising ? "▲" : "▼"}{rate.delta}
              </span>
            )}
          </StatusItem>
        </>
      )}

      {sheet === "status" && (
        <Suspense fallback={null}>
          <PickupHoursSheet open={shop.open} anchorTopPx={anchorTopPx} onClose={() => setSheet(null)} />
        </Suspense>
      )}
      {sheet === "rate" && config.usd_rate && (
        <Suspense fallback={null}>
          <FxRateSheet usdRate={config.usd_rate} anchorTopPx={anchorTopPx} onClose={() => setSheet(null)} />
        </Suspense>
      )}
    </div>
  );
}

/** Факт строки: содержимое плюс шеврон и добранная зона касания.
 *
 *  Никакой подложки, рамки и радиуса — иначе это снова чип, и мы возвращаемся
 *  к тому, с чего начали. Единственный видимый признак нажимаемости — шеврон. */
function StatusItem({
  onClick, ariaLabel, children,
}: {
  onClick: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="tap tap-area-control relative flex min-w-0 shrink items-center gap-1.5 text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
    >
      {children}
      <svg viewBox="0 0 24 24" aria-hidden className="h-3 w-3 shrink-0 text-muted"
        fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="m9 5 7 7-7 7" />
      </svg>
    </button>
  );
}
