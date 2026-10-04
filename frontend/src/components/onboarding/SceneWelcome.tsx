/** Слайд 1 — доверие и путь покупки. Бывшие «Доверие» и «Корзина» в одном
 *  экране: онбординг короче, а обещание «проверяем до оплаты» стоит рядом с
 *  тем, как до этой проверки дойти.
 *
 *  Три шага — настоящая последовательность, поэтому у них номера и линия,
 *  которая дорисовывается сверху вниз и зажигает шаг, до которого дошла.
 *  «N товаров» — live с бэкенда (CLAUDE.md, «Навигация каталога — только из
 *  данных»): цифра на первом экране не должна расходиться с базой. */
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { animateNumber, prefersReducedMotion } from "../../lib/motion";
import { PICKUP_ADDRESS } from "../../lib/pickup";
import { Icon } from "../icons";
import { Appear } from "./Appear";

const STEPS = [
  { title: "Выбираете в каталоге", note: "или просите ИИ подобрать" },
  { title: "Оставляете заявку", note: "менеджер ответит в Telegram" },
  { title: "Проверяете и платите", note: "технику смотрим вместе, до оплаты" },
];

const LINE_DELAY_MS = 450;
const LINE_MS = 1500;

type CategoryRow = { key: string; count: number };

export function SceneWelcome() {
  const lineRef = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState(0);
  const [products, setProducts] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ categories: CategoryRow[] }>("/catalog/categories")
      .then((data) => {
        if (cancelled) return;
        setProducts(data.categories.filter((c) => c.key !== "__sale__").reduce((s, c) => s + c.count, 0));
      })
      .catch(() => { /* цифра — украшение экрана, без неё строка просто не выходит */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    const ms = prefersReducedMotion() ? 500 : LINE_MS;
    let cancel = () => {};
    const timer = window.setTimeout(() => {
      // Значение уже с ease-out (мотор тормозит сам).
      cancel = animateNumber(0, 1, ms, (eased) => {
        line.style.transform = `scaleY(${eased})`;
        // Шаг зажигается, когда линия до него дошла: точки стоят на 0, ½, 1.
        setLit(Math.min(STEPS.length, Math.floor(eased * (STEPS.length - 1) + 1.02)));
      });
    }, LINE_DELAY_MS);
    return () => { window.clearTimeout(timer); cancel(); };
  }, []);

  return (
    <div
      className="app-hero flex h-full flex-col px-6 pb-8 text-white"
      style={{ paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 72px)" }}
    >
      <Appear className="text-[30px] font-extrabold leading-[1.1] tracking-[-0.03em] [text-wrap:balance]">
        <h1>
          Проверяем технику
          <br />
          <span className="text-[#8fd4ff]">вместе — до оплаты</span>
        </h1>
      </Appear>
      <Appear delayMs={120} className="mt-3 text-[15px] leading-snug text-white/80">
        <p>Гарантия 1 месяц на всё, что продаём</p>
      </Appear>

      <div className="relative mt-9 flex flex-col gap-7 pl-12">
        {/* Направляющая: серая целиком, светлая дорисовывается поверх. */}
        <div className="absolute bottom-[18px] left-[17px] top-[18px] w-[2px] rounded-full bg-white/15" />
        <div
          ref={lineRef}
          className="absolute bottom-[18px] left-[17px] top-[18px] w-[2px] origin-top rounded-full bg-[#8fd4ff]"
          style={{ transform: "scaleY(0)" }}
        />
        {STEPS.map((step, i) => {
          const on = lit > i;
          return (
            <Appear key={step.title} delayMs={200 + i * 90} className="relative">
              <span
                className={`absolute -left-12 top-0 flex h-9 w-9 items-center justify-center rounded-full text-[14px] font-bold ${
                  on ? "bg-[#8fd4ff] text-[#14304d]" : "bg-white/10 text-white/60"
                }`}
                style={{ transition: "none" }}
              >
                {i === STEPS.length - 1 && on ? <Icon name="check" className="h-4 w-4" strokeWidth={2.6} /> : i + 1}
              </span>
              <div className={`text-[17px] font-semibold ${on ? "text-white" : "text-white/60"}`}>{step.title}</div>
              <div className="mt-0.5 text-[13px] text-white/60">{step.note}</div>
            </Appear>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-8">
        <Appear delayMs={1900} className="flex items-center gap-2.5 text-[13px] text-white/80">
          <Icon name="pin" className="h-4 w-4 shrink-0 text-[#8fd4ff]" />
          Самовывоз — {PICKUP_ADDRESS}
        </Appear>
        <Appear delayMs={2000} className="flex items-center gap-2.5 text-[13px] text-white/80">
          <Icon name="truck" className="h-4 w-4 shrink-0 text-[#8fd4ff]" />
          Курьер по Москве, СДЭК по России
        </Appear>
        {products !== null && products > 0 && (
          <Appear delayMs={2100} className="flex items-center gap-2.5 text-[13px] text-white/80">
            <Icon name="box" className="h-4 w-4 shrink-0 text-[#8fd4ff]" />
            <span><b className="font-semibold text-white">{products.toLocaleString("ru-RU")}</b> товаров в каталоге</span>
          </Appear>
        )}
      </div>
    </div>
  );
}
