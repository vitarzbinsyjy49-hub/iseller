/** Слайд 4 — корзина → «Заявка отправлена». Переход между слоями —
 *  animateOpacity (не CSS-переход, см. lib/motion.ts), галочка успеха —
 *  AnimatedCheck как есть: это ровно тот кейс, под который она написана. */
import { useEffect, useRef, useState } from "react";
import { animateOpacity, transitionDuration } from "../../lib/motion";
import { AnimatedCheck } from "../AnimatedCheck";
import { Appear, staggerDelayMs } from "./Appear";

const CART_HOLD_MS = 2000;

export function SceneCart() {
  const cartRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<"cart" | "success">("cart");

  useEffect(() => {
    const timer = window.setTimeout(() => setStage("success"), CART_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (stage !== "success") return;
    const cart = cartRef.current;
    const success = successRef.current;
    if (!cart || !success) return;
    const ms = transitionDuration(300);
    const cancelOut = animateOpacity(cart, 1, 0, ms);
    const cancelIn = animateOpacity(success, 0, 1, ms);
    return () => { cancelOut(); cancelIn(); };
  }, [stage]);

  return (
    <div className="relative h-full bg-bg">
      <div
        ref={cartRef} className="absolute inset-0 flex flex-col px-6 pb-8"
        style={{ paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 64px)" }}
      >
        <Appear className="text-[12px] font-semibold uppercase tracking-[0.06em] text-accent">
          АйСеллер
        </Appear>
        <Appear delayMs={80} className="mt-2 text-[27px] font-extrabold tracking-[-0.03em] text-text">
          <h1>Ваша заявка</h1>
        </Appear>

        <div className="mt-6 flex flex-col gap-3">
          <Appear delayMs={staggerDelayMs(0)} className="flex items-center gap-3 rounded-xl2 border border-border bg-surface p-3">
            <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-field bg-mutedbg text-[22px]">📱</div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-text">Apple iPhone 17 Pro 256 ГБ Blue (KR-HK)</div>
              <div className="mt-0.5 text-[14px] font-bold text-text">99 300 ₽</div>
            </div>
          </Appear>
          <Appear delayMs={staggerDelayMs(1)} className="flex items-center gap-3 rounded-xl2 border border-border bg-surface p-3">
            <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-field bg-accent/10 text-[20px]">🎧</div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-text">Apple AirPods 4 (2024) с шумоподавлением</div>
              <div className="mt-0.5 text-[14px] font-bold text-text">13 900 ₽</div>
            </div>
          </Appear>
        </div>

        <Appear delayMs={680} className="mt-5 flex items-baseline justify-between px-0.5">
          <span className="text-[14px] text-muted">Итого</span>
          <span className="text-[22px] font-extrabold tracking-[-0.02em] text-text">113 200 ₽</span>
        </Appear>

        <Appear delayMs={850} className="mt-auto rounded-card bg-accent py-4 text-center text-[15px] font-semibold text-white">
          Отправить заявку
        </Appear>
      </div>

      <div ref={successRef} className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center opacity-0">
        {stage === "success" && <AnimatedCheck />}
        <div className="mt-5 text-[27px] font-extrabold tracking-[-0.03em] text-text">Заявка отправлена</div>
        <div className="mt-2 text-[14px] leading-relaxed text-muted">
          Менеджер свяжется с вами в Telegram —<br /><b className="text-text">кэшбек уже начислен</b> баллами
        </div>
      </div>
    </div>
  );
}
