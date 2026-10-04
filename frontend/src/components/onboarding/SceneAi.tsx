/** Слайд 3 — ИИ-подбор. Мини-сценка чата: вопрос печатается, ИИ «думает»,
 *  приходит ответ с карточками.
 *
 *  Карточки — настоящие товары из каталога под этот же вопрос (айфон до
 *  100 000 ₽, в наличии), а не нарисованные: на первом экране нельзя
 *  показывать то, чего человек потом не найдёт. Текст ответа — сценарий, и
 *  поэтому он ничего не утверждает про конкретную модель, только ведёт к
 *  карточкам. Нет подходящих товаров — ответ честно без них.
 *
 *  Знака Claude тут нет по той же причине, что в кнопке «✨ ИИ» (CLAUDE.md):
 *  движок бывает и не Claude. */
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { formatPrice } from "../../lib/format";
import { animateLinear, prefersReducedMotion } from "../../lib/motion";
import type { ProductCard as TCard } from "../ai/types";
import { Icon } from "../icons";
import { Appear } from "./Appear";

const QUESTION = "Нужен айфон до 100 тысяч, чтобы хорошо снимал";
const BUDGET = 100_000;

const TYPE_START_MS = 350;
const TYPE_MS = 1300;
const THINK_MS = 1000;

export function SceneAi() {
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [typed, setTyped] = useState(0);
  const [stage, setStage] = useState<"typing" | "thinking" | "answer">("typing");
  const dotsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ cards: TCard[] }>(`/catalog/list?query=iphone&price_max=${BUDGET}&in_stock=true&condition=new&limit=8`)
      // ASIS (витрина/уценка) в базе числится condition=new — отметка есть
      // только в названии (services/bsa_parser). Первым впечатлением о
      // «новом айфоне» она быть не должна.
      .then((d) => {
        if (cancelled) return;
        setCards(d.cards.filter((c) => c.price > 0 && !c.price_note && !/asis/i.test(c.title)).slice(0, 2));
      })
      .catch(() => { if (!cancelled) setCards([]); });
    return () => { cancelled = true; };
  }, []);

  // Вопрос печатается по буквам, затем пауза «думает», затем ответ.
  useEffect(() => {
    const reduced = prefersReducedMotion();
    let cancel = () => {};
    const timers: number[] = [];
    if (reduced) {
      setTyped(QUESTION.length);
      timers.push(window.setTimeout(() => setStage("answer"), 600));
    } else {
      timers.push(window.setTimeout(() => {
        cancel = animateLinear(0, QUESTION.length, TYPE_MS, (v) => setTyped(Math.round(v)), () => {
          setStage("thinking");
          timers.push(window.setTimeout(() => setStage("answer"), THINK_MS));
        });
      }, TYPE_START_MS));
    }
    return () => { cancel(); timers.forEach((t) => window.clearTimeout(t)); };
  }, []);

  // Три точки «печатает» — волна прозрачности, своими кадрами.
  useEffect(() => {
    const dots = dotsRef.current;
    if (stage !== "thinking" || !dots || prefersReducedMotion()) return;
    let cancel = () => {};
    const loop = () => {
      cancel = animateLinear(0, 1, 900, (t) => {
        Array.from(dots.children).forEach((dot, i) => {
          const phase = (t * 3 - i + 3) % 3;
          (dot as HTMLElement).style.opacity = String(phase < 1 ? 0.35 + 0.65 * Math.sin(phase * Math.PI) : 0.35);
        });
      }, loop);
    };
    loop();
    return () => cancel();
  }, [stage]);

  const found = cards && cards.length > 0;

  return (
    <div
      className="app-hero flex h-full flex-col px-6 pb-8 text-white"
      style={{ paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 72px)" }}
    >
      <Appear className="text-[30px] font-extrabold leading-[1.1] tracking-[-0.03em] [text-wrap:balance]">
        <h1>
          Не знаете, что выбрать?
          <br />
          <span className="text-[#8fd4ff]">Спросите ИИ</span>
        </h1>
      </Appear>
      <Appear delayMs={120} className="mt-3 text-[15px] leading-snug text-white/80">
        <p>Своими словами — он подберёт из того, что есть в наличии</p>
      </Appear>

      <div className="mt-8 flex flex-col gap-3">
        <div className="max-w-[86%] self-end rounded-[20px] rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-snug text-white">
          {QUESTION.slice(0, typed)}
          {stage === "typing" && <span className="ml-px inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-white/80" />}
        </div>

        {stage === "thinking" && (
          <div className="flex items-center gap-2 self-start">
            <Avatar />
            <div ref={dotsRef} className="flex gap-1 rounded-[20px] rounded-bl-md bg-white/10 px-4 py-3.5">
              {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 rounded-full bg-white" style={{ opacity: 0.35 }} />)}
            </div>
          </div>
        )}

        {stage === "answer" && (
          <div className="flex items-start gap-2 self-start">
            <Avatar />
            <div className="flex min-w-0 max-w-[88%] flex-col gap-2">
              <Appear className="rounded-[20px] rounded-bl-md bg-white/10 px-4 py-2.5 text-[15px] leading-snug">
                {found
                  ? <>Вот что есть в наличии до {formatPrice(BUDGET)} — сравним по камере?</>
                  : <>Подберу по бюджету и задачам — и сразу покажу, что есть в наличии.</>}
              </Appear>
              {cards?.map((card, i) => (
                <Appear key={card.id} delayMs={220 + i * 140}
                  className="flex items-center gap-3 rounded-2xl bg-white p-2 pr-3 text-text">
                  {/* Не ProductImage: тот ленивый и проявляется по onLoad с
                      отступом под карточку ленты — в строке 48px фото выходило
                      крошечным и появлялось позже самой строки. */}
                  <img src={card.image} alt="" decoding="async"
                    className="h-12 w-12 shrink-0 rounded-xl bg-mutedbg object-contain p-1" />
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-[12.5px] font-medium leading-tight">{card.title_clean || card.title}</div>
                    <div className="mt-0.5 text-[14px] font-bold">{formatPrice(card.price)}</div>
                  </div>
                </Appear>
              ))}
            </div>
          </div>
        )}
      </div>

      <Appear delayMs={900} className="mt-auto flex items-center gap-2 pt-6 text-[13px] text-white/70">
        <Icon name="search" className="h-4 w-4 shrink-0 text-[#8fd4ff]" />
        <p>Кнопка <b className="font-semibold text-white">✨ ИИ</b> — в строке поиска</p>
      </Appear>
    </div>
  );
}

function Avatar() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#8fd4ff] text-[#14304d]">
      <Icon name="sparkles" className="h-4 w-4" />
    </span>
  );
}
