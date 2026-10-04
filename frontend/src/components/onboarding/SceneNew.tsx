/** Слайд 2 — новинки. Карточки — та же подборка, что секция «Новинки» на
 *  главной (`/catalog/feed` → `new`), поэтому экран не устаревает: вышел
 *  новый iPhone, его завели в каталог — онбординг показывает уже его.
 *
 *  Лента едет сама, бесконечно (две копии ряда, сдвиг по модулю ширины
 *  одной). Жесты у ленты не свои: палец листает сторис, а тянуть карточку и
 *  листать экраны одним жестом нельзя — один из двух всегда проигрывает. */
import { useEffect, useRef, useState } from "react";
import { cachedApi } from "../../lib/apiCache";
import { animateLinear, prefersReducedMotion } from "../../lib/motion";
import type { ProductCard as TCard } from "../ai/types";
import ProductCard from "../ProductCard";
import { Appear } from "./Appear";

/** px в секунду: медленно, чтобы успеть прочитать название, но заметно. */
const DRIFT_SPEED = 34;

export function SceneNew() {
  const [cards, setCards] = useState<TCard[] | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    cachedApi<{ new: TCard[] }>("/catalog/feed")
      .then((data) => { if (!cancelled) setCards(data.new.slice(0, 8)); })
      .catch(() => { if (!cancelled) setCards([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const row = rowRef.current;
    const copy = copyRef.current;
    if (!row || !copy || !cards?.length || prefersReducedMotion()) return;
    const loop = copy.offsetWidth;
    if (loop <= 0) return;
    let cancel = () => {};
    const run = (from: number) => {
      const ms = ((loop - from) / DRIFT_SPEED) * 1000;
      cancel = animateLinear(from, loop, ms, (x) => { row.style.transform = `translate3d(${-x}px,0,0)`; }, () => run(0));
    };
    run(0);
    return () => cancel();
  }, [cards]);

  return (
    <div
      className="flex h-full flex-col bg-bg"
      style={{ paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 72px)" }}
    >
      <div className="px-6">
        <Appear className="text-[30px] font-extrabold leading-[1.1] tracking-[-0.03em] text-text [text-wrap:balance]">
          <h1>
            Новинки —
            <br />
            <span className="text-accent">уже в каталоге</span>
          </h1>
        </Appear>
        <Appear delayMs={120} className="mt-3 max-w-[320px] text-[15px] leading-snug text-muted">
          <p>Apple, Dyson, PlayStation. Цены — актуальные, в рублях</p>
        </Appear>
      </div>

      <Appear delayMs={240} className="pointer-events-none mt-8 overflow-hidden">
        {cards === null ? (
          <div className="flex gap-3 px-6">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-60 w-40 shrink-0 rounded-xl2" />)}
          </div>
        ) : (
          <div ref={rowRef} className="flex w-max will-change-transform">
            <div ref={copyRef} className="flex gap-3 pl-6 pr-3">
              {cards.map((card) => <ProductCard key={card.id} card={card} compact />)}
            </div>
            {/* Вторая копия — хвост бесконечной ленты, для скринридера её нет. */}
            <div aria-hidden className="flex gap-3 pr-3">
              {cards.map((card) => <ProductCard key={card.id} card={card} compact />)}
            </div>
          </div>
        )}
      </Appear>

      <Appear delayMs={420} className="mt-auto px-6 pb-10 text-[13px] leading-relaxed text-muted">
        <p>Одна карточка — вся модель: цвет и память выбираются внутри</p>
      </Appear>
    </div>
  );
}
