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
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "./icons";
import { useLeadsBadge } from "../store/leadsBadge";
import { usePublicConfig } from "../lib/appConfig";
import { formatFxChip } from "../lib/fxFormat";
import { moscowHour, pickupStatus, PICKUP_CLOSE_HOUR, PICKUP_OPEN_HOUR } from "../lib/pickup";
import { track } from "../lib/analytics";

const PickupHoursSheet = lazy(() => import("./PickupHoursSheet"));
const FxRateSheet = lazy(() => import("./FxRateSheet"));

/** Как часто пересчитывается московский час. */
const CLOCK_TICK_MS = 60_000;

type Sheet = "status" | "rate";

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

  return (
    <div
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
          onClick={() => setSheet("status")}
          ariaLabel={`Точка выдачи ${shop.open ? "открыта" : "закрыта"}, ${shop.label}. Подробнее`}
        >
          <span
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
            onClick={() => setSheet("rate")}
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
