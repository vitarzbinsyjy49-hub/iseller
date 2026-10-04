/** Слайд 4 — кэшбек и уровни.
 *
 *  Лестница приходит с сервера (`/loyalty/me` → `levels`), как и на экране
 *  `/loyalty`. Прежний слайд держал свою копию «0,25% → 2%» с выдуманными
 *  названиями уровней — лояльность пересобрали, а онбординг ещё полгода
 *  обещал старые ставки. Вторая копия порогов разъезжается всегда.
 *
 *  Ступени растут по очереди, а крупная цифра досчитывает до ставки той
 *  ступени, которая сейчас выросла, — один мотор на оба значения, чтобы они
 *  не могли разойтись. Плашка акции первой покупки — только если акция
 *  реально действует для этого человека (`next_purchase.promo`). */
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { animateNumber, prefersReducedMotion } from "../../lib/motion";
import { Icon } from "../icons";
import { Appear } from "./Appear";

type Level = { key: string; title: string; threshold: number; rate_percent: number };
type LoyaltyMe = {
  levels: Level[];
  next_purchase?: { rate_percent: number; promo: string | null };
};

const GROW_DELAY_MS = 500;
const GROW_MS = 1900;

function pct(v: number): string {
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
}

function thresholdLabel(rub: number): string {
  if (rub <= 0) return "сразу";
  if (rub >= 1_000_000) return `от ${(rub / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`;
  return `от ${Math.round(rub / 1000)} тыс`;
}

export function SceneLoyalty() {
  const [data, setData] = useState<LoyaltyMe | null>(null);
  const [failed, setFailed] = useState(false);
  const [rate, setRate] = useState<number | null>(null);
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<LoyaltyMe>("/loyalty/me?history_limit=1")
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const levels = data?.levels ?? [];
  const top = levels.length ? levels[levels.length - 1].rate_percent : 0;

  useEffect(() => {
    if (!levels.length) return;
    const n = levels.length;
    const ms = prefersReducedMotion() ? 700 : GROW_MS;
    let cancel = () => {};
    const timer = window.setTimeout(() => {
      cancel = animateNumber(0, n, ms, (v) => {
        barRefs.current.forEach((bar, i) => {
          if (bar) bar.style.transform = `scaleY(${Math.max(0, Math.min(1, v - i))})`;
        });
        const reached = Math.max(0, Math.min(n - 1, Math.floor(v - 0.001)));
        const part = Math.max(0, Math.min(1, v - reached));
        const prev = reached > 0 ? levels[reached - 1].rate_percent : 0;
        setRate(prev + (levels[reached].rate_percent - prev) * part);
      });
    }, GROW_DELAY_MS);
    return () => { window.clearTimeout(timer); cancel(); };
    // levels приходят один раз; массив из ответа сравнивать по ссылке незачем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const promo = data?.next_purchase?.promo ? data.next_purchase : null;

  return (
    <div
      className="flex h-full flex-col bg-bg px-6 pb-8"
      style={{ paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 72px)" }}
    >
      <Appear className="text-[30px] font-extrabold leading-[1.1] tracking-[-0.03em] text-text [text-wrap:balance]">
        <h1>
          Кэшбек баллами
          <br />
          <span className="text-accent">{top ? `до ${pct(top)}` : "с каждой покупки"}</span>
        </h1>
      </Appear>
      <Appear delayMs={120} className="mt-3 max-w-[320px] text-[15px] leading-snug text-muted">
        <p>1 балл = 1 ₽. Ставка растёт с суммой покупок и не падает, когда тратите баллы</p>
      </Appear>

      {promo && (
        <Appear delayMs={260} className="mt-5 inline-flex items-center gap-2 self-start rounded-full bg-accent/10 px-3.5 py-2 text-[13px] font-semibold text-accent">
          <Icon name="flame" className="h-4 w-4" />
          Первая покупка — {pct(promo.rate_percent)} кэшбека
        </Appear>
      )}

      {levels.length > 0 && (
        <>
          <div className="mt-7 text-[64px] font-extrabold leading-none tracking-[-0.03em] text-text tabular-nums">
            {rate === null ? "0" : rate.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            <span className="ml-0.5 text-[30px] font-bold text-accent">%</span>
          </div>

          <div className="mt-6 flex h-[150px] items-end gap-2">
            {levels.map((l, i) => (
              <div key={l.key} className="flex h-full flex-1 flex-col justify-end">
                <div className="mb-1.5 text-center text-[12px] font-bold text-text tabular-nums">{pct(l.rate_percent)}</div>
                <div
                  ref={(el) => { barRefs.current[i] = el; }}
                  className={`origin-bottom rounded-t-[10px] ${i === levels.length - 1 ? "bg-accent" : "bg-accent/25"}`}
                  style={{ height: `${28 + (l.rate_percent / top) * 72}%`, transform: "scaleY(0)" }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            {levels.map((l) => (
              <div key={l.key} className="min-w-0 flex-1 text-center">
                <div className="truncate text-[11.5px] font-semibold text-text">{l.title}</div>
                <div className="truncate text-[10.5px] text-muted">{thresholdLabel(l.threshold)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {data === null && !failed && <div className="skeleton mt-8 h-[220px] w-full rounded-xl2" />}

      <Appear delayMs={2600} className="mt-auto pt-6 text-[13px] leading-relaxed text-muted">
        <p>Баллы начисляются сами после покупки — <b className="text-text">без промокодов</b>. Ими можно оплатить часть следующей</p>
      </Appear>
    </div>
  );
}
