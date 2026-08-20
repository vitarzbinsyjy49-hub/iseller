/** Слайд 3 — лояльность/кэшбек. Шкала и счётчик "0,25 → 2%" — ОДИН
 *  animateNumber на оба значения разом: раньше (в static-экспорте) это были
 *  отдельная CSS-анимация ширины и свой independent requestAnimationFrame
 *  скрипт, и они могли разойтись по времени. */
import { useEffect, useRef, useState } from "react";
import { animateNumber, prefersReducedMotion } from "../../lib/motion";
import { Appear } from "./Appear";

const START_RATE = 0.25;
const TOP_RATE = 2;
const START_WIDTH = 12;
const TOP_WIDTH = 96;

const LEVELS = [
  { label: "Старт", rate: "0,25%" },
  { label: "Клиент", rate: "0,5%" },
  { label: "Постоянный", rate: "1%" },
  { label: "Топ", rate: "2%" },
];

export function SceneLoyalty() {
  const fillRef = useRef<HTMLDivElement>(null);
  const [rateText, setRateText] = useState("0,25");

  useEffect(() => {
    const fill = fillRef.current;
    if (!fill) return;
    // transitionDuration() здесь не годится: 160мс — темп замены СДВИГА на
    // затухание (направление всё равно не считать), а тут анимируется ЧИСЛО —
    // сама суть слайда в том, что ставка растёт на глазах. Схлопнуть до 160мс
    // значит показать сразу «2%» без смысла шкалы. Короче обычного (уважаем
    // «меньше движения»), но не мгновенно.
    const ms = prefersReducedMotion() ? 900 : 2200;
    const cancel = animateNumber(0, 1, ms, (t) => {
      const eased = 1 - (1 - t) ** 3;
      fill.style.width = `${START_WIDTH + eased * (TOP_WIDTH - START_WIDTH)}%`;
      setRateText((START_RATE + eased * (TOP_RATE - START_RATE)).toFixed(2).replace(".", ","));
    });
    return cancel;
  }, []);

  return (
    <div
      className="flex h-full flex-col items-center bg-bg px-6 text-center"
      style={{ paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 64px)" }}
    >
      <Appear className="text-[12px] font-semibold uppercase tracking-[0.06em] text-accent">
        АйСеллер · Лояльность
      </Appear>
      <Appear delayMs={80} className="mt-2 text-[27px] font-extrabold leading-[1.15] tracking-[-0.03em] text-text">
        <h1>
          Кэшбек баллами
          <br />
          с каждой покупки
        </h1>
      </Appear>

      <Appear delayMs={160} className="mt-10 w-full max-w-[300px]">
        <div className="mb-2 flex justify-between text-[13px] text-muted">
          <span>0,25%</span>
          <span>2%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-mutedbg">
          <div ref={fillRef} className="h-full rounded-full bg-gradient-to-r from-accent to-green" style={{ width: `${START_WIDTH}%` }} />
        </div>
      </Appear>

      <div className="mt-7 text-[60px] font-extrabold leading-none tracking-[-0.03em] text-text tabular-nums">
        {rateText}<span className="text-[28px] font-bold text-accent">%</span>
      </div>
      <Appear delayMs={2900} className="mt-1.5 text-[14px] text-muted">
        ставка растёт с оборотом покупок
      </Appear>

      <div className="mt-9 flex w-full gap-2">
        {LEVELS.map((l, i) => (
          <Appear
            key={l.label}
            delayMs={3000 + i * 100}
            className={`flex-1 rounded-card px-1.5 py-2.5 text-[11px] font-semibold ${
              i === LEVELS.length - 1 ? "bg-accent text-white" : "bg-mutedbg text-muted"
            }`}
          >
            {l.label}
            <div className="mt-0.5 text-[13px]">{l.rate}</div>
          </Appear>
        ))}
      </div>

      <Appear delayMs={3500} className="mt-7 max-w-[280px] text-[13px] leading-relaxed text-muted">
        <p>Баллы копятся автоматически — <b className="text-text">без промокодов</b> и лишних шагов</p>
      </Appear>
    </div>
  );
}
