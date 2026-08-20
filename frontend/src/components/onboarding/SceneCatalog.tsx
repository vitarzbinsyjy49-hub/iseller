/** Слайд 2 — каталог. Реальные карточки live с бэкенда (не зашитые SKU/цены
 *  из дизайна — см. решение в плане), статичный ряд без непрерывного
 *  автоскролла: слайд живёт ~5с, бесконечная карусель на этом хронометраже
 *  почти всегда обрежется на середине проезда. */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { ProductCard as TCard } from "../ai/types";
import ProductCard from "../ProductCard";
import { Appear, staggerDelayMs } from "./Appear";

export function SceneCatalog() {
  const [cards, setCards] = useState<TCard[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ cards: TCard[] }>("/catalog/list?in_stock=true&limit=4")
      .then((data) => { if (!cancelled) setCards(data.cards); })
      .catch(() => { if (!cancelled) setCards([]); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div
      className="flex h-full flex-col bg-bg px-6"
      style={{ paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 64px)" }}
    >
      <Appear className="text-[12px] font-semibold uppercase tracking-[0.06em] text-accent">
        АйСеллер
      </Appear>
      <Appear delayMs={80} className="mt-2 text-[27px] font-extrabold leading-[1.15] tracking-[-0.03em] text-text">
        <h1>
          Apple, Dyson, <span className="text-accent">PlayStation</span> —
          <br />
          по актуальным ценам
        </h1>
      </Appear>

      <div className="mt-7 -mx-6 flex gap-3 overflow-hidden px-6">
        {cards === null && [0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-56 w-40 shrink-0 rounded-xl2" />
        ))}
        {cards?.map((card, i) => (
          <Appear key={card.id} delayMs={staggerDelayMs(i)} className="pointer-events-none">
            <ProductCard card={card} compact />
          </Appear>
        ))}
      </div>
    </div>
  );
}
