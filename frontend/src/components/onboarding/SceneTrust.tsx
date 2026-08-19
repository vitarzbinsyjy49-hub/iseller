/** Слайд 1 — доверие/гарантия. "N товаров · M категорий" — live с бэкенда
 *  (не зашито): проект уже ловил баг «цифра на витрине разошлась с базой»
 *  (см. CLAUDE.md, «Навигация каталога — только из данных»), и первый экран
 *  нового пользователя — последнее место, где стоит рисковать этим снова. */
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { animateNumber, transitionDuration } from "../../lib/motion";
import { Icon } from "../icons";

// Кольцо r=42 (окружность 264) и штрих галочки — те же числа, что уже
// проверены в exported-превью (artifacts/onboarding-content/scenes/scene-cart.html).
const RING_CIRCUMFERENCE = 264;
const TICK_LENGTH = 50;

type CategoryRow = { key: string; count: number };

export function SceneTrust() {
  const ringRef = useRef<SVGCircleElement>(null);
  const tickRef = useRef<SVGPathElement>(null);
  const [stats, setStats] = useState<{ products: number; categories: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ categories: CategoryRow[] }>("/catalog/categories")
      .then((data) => {
        if (cancelled) return;
        const real = data.categories.filter((c) => c.key !== "__sale__");
        setStats({
          products: real.reduce((sum, c) => sum + c.count, 0),
          categories: real.length,
        });
      })
      .catch(() => { /* стата — украшение экрана, не критична для онбординга */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const ring = ringRef.current;
    const tick = tickRef.current;
    if (!ring || !tick) return;
    const ringMs = transitionDuration(500);
    const tickMs = transitionDuration(350);
    const cancelRing = animateNumber(RING_CIRCUMFERENCE, 0, ringMs,
      (v) => { ring.style.strokeDashoffset = String(v); },
      () => {
        cancelTick = animateNumber(TICK_LENGTH, 0, tickMs,
          (v) => { tick.style.strokeDashoffset = String(v); });
      });
    let cancelTick = () => {};
    return () => { cancelRing(); cancelTick(); };
  }, []);

  return (
    <div
      className="app-hero flex h-full flex-col items-center justify-center px-8 text-center text-white"
      style={{ paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 24px)" }}
    >
      <div className="onboarding-appear text-[13px] font-semibold uppercase tracking-[0.06em] text-white/80">
        АйСеллер
      </div>

      <div className="onboarding-appear relative mt-8 flex h-24 w-24 items-center justify-center" style={{ animationDelay: "80ms" }}>
        <svg viewBox="0 0 96 96" className="h-24 w-24">
          <circle
            ref={ringRef} cx="48" cy="48" r="42" fill="none" stroke="#8fd4ff" strokeWidth="3"
            strokeLinecap="round" strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={RING_CIRCUMFERENCE}
            transform="rotate(-90 48 48)"
          />
          <path
            ref={tickRef} d="M32 49 L44 61 L66 37" fill="none" stroke="#fff" strokeWidth="5"
            strokeLinecap="round" strokeLinejoin="round" strokeDasharray={TICK_LENGTH} strokeDashoffset={TICK_LENGTH}
          />
        </svg>
      </div>

      <h1 className="onboarding-appear mt-7 text-[28px] font-extrabold leading-[1.15] tracking-[-0.03em]" style={{ animationDelay: "160ms" }}>
        Проверяем технику
        <br />
        <span className="text-[#8fd4ff]">вместе — до оплаты</span>
      </h1>
      <p className="onboarding-appear mt-3 text-[15px] text-white/85" style={{ animationDelay: "220ms" }}>
        Гарантия 1 месяц на всё, что мы продаём
      </p>

      <div className="stagger mt-8 flex w-full flex-col gap-2.5">
        <div className="onboarding-appear flex items-center gap-2.5 rounded-card bg-white/[0.13] px-4 py-3 text-left text-[13px] text-white/90">
          <Icon name="pin" className="h-4 w-4 shrink-0 text-[#8fd4ff]" />
          Самовывоз — Горбушка, Москва · 10:00–21:00
        </div>
        <div className="onboarding-appear flex items-center gap-2.5 rounded-card bg-white/[0.13] px-4 py-3 text-left text-[13px] text-white/90">
          <Icon name="truck" className="h-4 w-4 shrink-0 text-[#8fd4ff]" />
          Доставка курьером по Москве, СДЭК по России
        </div>
        <div className="onboarding-appear flex items-center gap-2.5 rounded-card bg-white/[0.13] px-4 py-3 text-left text-[13px] text-white/90">
          <Icon name="shield" className="h-4 w-4 shrink-0 text-[#8fd4ff]" />
          {stats
            ? <span><b className="font-semibold text-white">{stats.products}</b> товаров в наличии · {stats.categories} категорий</span>
            : <span className="skeleton inline-block h-3.5 w-40 rounded" />}
        </div>
      </div>
    </div>
  );
}
