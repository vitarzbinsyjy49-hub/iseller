import { useCallback, useEffect, useRef, useState } from "react";
import { formatPrice } from "../lib/format";
import { haptic } from "../lib/telegram";
import {
  cappedDiscount,
  forgetCode,
  loadSavedCode,
  normalizeCode,
  previewPromo,
  saveCode,
  totalWithDiscount,
  validateCode,
  type PromoOffer,
} from "../lib/promo";

/** Применённая скидка. `discount` — то, что ПОКАЗЫВАТЬ; при оформлении сервер
 *  посчитает её заново по актуальному каталогу, и его цифра главнее. Наверх она
 *  уходит только затем, чтобы кнопка оформления не спорила с итогом над ней. */
export type AppliedPromo = { code: string; discount: number };

type Props = {
  /** Предварительная сумма корзины — от неё считается скидка. */
  subtotal: number;
  onChange: (promo: AppliedPromo | null) => void;
};

/** Поле промокода в корзине.
 *
 *  Проверка кода купон НЕ тратит — списание происходит только при оформлении
 *  заявки. Поэтому вводить можно сколько угодно: акции это ничего не стоит.
 */
export default function PromoField({ subtotal, onChange }: Props) {
  const [input, setInput] = useState("");
  const [offer, setOffer] = useState<PromoOffer | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "error">("idle");
  const [error, setError] = useState("");
  const restored = useRef(false);

  const apply = useCallback(async (raw: string, silent = false) => {
    const problem = validateCode(raw);
    if (problem) {
      if (!silent) { setError(problem); setState("error"); }
      return;
    }
    setState("checking");
    setError("");
    try {
      const result = await previewPromo(raw);
      setOffer(result);
      setState("idle");
      saveCode(result.code);
      onChange({ code: result.code, discount: result.discount });
      if (!silent) haptic("rigid");
    } catch (e) {
      // Код мог кончиться или истечь, пока корзина лежала. Молча оставить его
      // применённым нельзя: человек увидит одну сумму, а получит другую.
      setOffer(null);
      forgetCode();
      onChange(null);
      setState(silent ? "idle" : "error");
      if (!silent) setError(e instanceof Error ? e.message : "Промокод не применился");
    }
  }, [onChange]);

  // Применённый код переживает перезагрузку, но НЕ переживает молча смену
  // условий: при возврате он перепроверяется на актуальной корзине.
  useEffect(() => {
    if (restored.current || subtotal <= 0) return;
    restored.current = true;
    const saved = loadSavedCode();
    if (saved) { setInput(saved); void apply(saved, true); }
  }, [subtotal, apply]);

  // Корзину поменяли — прежняя скидка может уже не действовать (например,
  // сумма упала ниже порога). Перепроверяем молча.
  const lastChecked = useRef<number | null>(null);
  useEffect(() => {
    if (!offer || subtotal <= 0) return;
    if (lastChecked.current === subtotal) return;
    lastChecked.current = subtotal;
    if (Math.abs(subtotal - offer.subtotal) > 0.005) void apply(offer.code, true);
  }, [subtotal, offer, apply]);

  function remove() {
    setOffer(null);
    setInput("");
    setError("");
    setState("idle");
    forgetCode();
    onChange(null);
  }

  if (offer) {
    const discount = cappedDiscount(subtotal, offer.discount);
    return (
      <div className="mt-3 rounded-xl2 bg-surface p-4 shadow-soft">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-muted">Сумма</span>
          <span className="text-[13px] tabular-nums text-muted">{formatPrice(subtotal)}</span>
        </div>
        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[13px] font-medium text-green">
            Промокод {offer.code}
          </span>
          <span className="shrink-0 text-[13px] font-medium tabular-nums text-green">
            −{formatPrice(discount)}
          </span>
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border pt-2">
          <span className="text-[15px] font-semibold">Итого</span>
          <span className="text-xl font-bold tabular-nums">
            {formatPrice(totalWithDiscount(subtotal, discount))}
          </span>
        </div>
        <button
          type="button"
          onClick={remove}
          className="tap mt-2 text-[12px] font-medium text-muted"
        >
          Убрать промокод
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl2 bg-surface p-4 shadow-soft">
      <label className="block text-[13px] font-semibold" htmlFor="promo-code">
        Промокод
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="promo-code"
          value={input}
          onChange={(e) => { setInput(normalizeCode(e.target.value)); setError(""); setState("idle"); }}
          onKeyDown={(e) => { if (e.key === "Enter") void apply(input); }}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="START20"
          className="min-w-0 flex-1 rounded-xl2 border border-border bg-mutedbg px-3.5 py-2.5 text-sm uppercase outline-none transition-colors focus:border-accent focus:bg-surface"
        />
        <button
          type="button"
          onClick={() => void apply(input)}
          disabled={!input.trim() || state === "checking"}
          className="tap shrink-0 rounded-xl2 bg-accent px-4 text-sm font-semibold text-white disabled:opacity-40"
        >
          {state === "checking" ? "…" : "Применить"}
        </button>
      </div>
      {state === "error" && error && (
        <p className="mt-2 text-[12px] leading-4 text-danger">{error}</p>
      )}
    </div>
  );
}
