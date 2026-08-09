import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { formatPrice } from "../lib/format";
import { haptic } from "../lib/telegram";
import { FADE_MS, animateNumber, animateOpacity, prefersReducedMotion } from "../lib/motion";
import {
  buildPriceOfferBody,
  planReveal,
  priceGap,
  validateOfferPrice,
  validateOfferUrl,
} from "../lib/priceOffer";

const OPEN_MS = 240;

type Props = {
  productId: number;
  /** Наша цена — нужна только для подписи «дешевле на N». */
  ourPrice?: number | null;
};

/** «Нашли дешевле?» — ссылка на тот же товар у конкурента.
 *
 *  Разворачивается В ПОТОКЕ страницы, а не шторкой: человек уже смотрит на
 *  цену, и увозить его на отдельный экран, чтобы он вставил ссылку, значит
 *  потерять половину по дороге. Форма остаётся рядом с тем, о чём она.
 *
 *  Раскрытие и подтверждение считаются кадрами (`lib/motion`), а не CSS: на
 *  части устройств система гасит декларативную анимацию разом, и переход
 *  превращается в щелчок. Правило оттуда же: «убрать движение» — это НЕ
 *  «убрать событие», поэтому при «уменьшить движение» блок не выезжает, но
 *  проявляется.
 */
export default function PriceOfferBlock({ productId, ourPrice }: Props) {
  const [mounted, setMounted] = useState(false);   // есть ли содержимое в DOM
  const [open, setOpen] = useState(false);          // намерение показать
  const [url, setUrl] = useState("");
  const [price, setPrice] = useState("");
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  const boxRef = useRef<HTMLDivElement>(null);      // анимируемая обёртка
  const bodyRef = useRef<HTMLDivElement>(null);     // измеряемое содержимое
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** Показан ли блок сейчас. Нужен, чтобы отличить открытие от смены
   *  содержимого внутри уже открытого блока. */
  const shownRef = useRef(false);
  /** Высота, до которой доехала прошлая анимация. Хранится, а не измеряется:
   *  после анимации height=auto, и замер вернул бы уже НОВЫЙ размер. */
  const heightRef = useRef(0);

  const urlError = validateOfferUrl(url);
  const priceError = validateOfferPrice(price);
  const gap = priceGap(ourPrice, price);
  const canSend = !urlError && !priceError && state !== "sending";

  // Высота считается по факту содержимого, а не по угаданной константе: в блоке
  // то форма, то подтверждение, и они разной высоты.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const body = bodyRef.current;
    if (!box) return;
    if (!mounted) return;

    // Измеряем содержимое, но НЕ «откуда ехать»: к layout-фазе коробка уже
    // получила натуральную высоту, и замер дал бы «откуда == куда». Прошлую
    // высоту помним сами. Решение, чем показывать, принимает planReveal.
    const measured = body ? body.scrollHeight : 0;
    const plan = planReveal({
      measured,
      previousHeight: heightRef.current,
      openingNow: !shownRef.current,
      reducedMotion: prefersReducedMotion(),
    });
    shownRef.current = true;
    if (measured > 0) heightRef.current = measured;

    if (plan.kind === "instant") {
      box.style.height = "auto";
      box.style.opacity = "1";
      return;
    }
    if (plan.kind === "fade") {
      box.style.height = "auto";
      // Ставим 0 в layout-фазе, ДО отрисовки: иначе кадр с готовым блоком
      // успеет мелькнуть и затухание превратится в моргание.
      box.style.opacity = "0";
      return animateOpacity(box, 0, 1, FADE_MS);
    }

    box.style.opacity = "1";
    box.style.height = `${plan.from}px`;
    return animateNumber(plan.from, plan.to, OPEN_MS, (v) => {
      box.style.height = `${v}px`;
    }, () => {
      // auto — чтобы блок пережил переворот экрана и перенос строки внутри.
      box.style.height = "auto";
    });
  }, [mounted, state]);

  const close = useCallback(() => {
    const box = boxRef.current;
    setOpen(false);
    shownRef.current = false;
    if (!box) { setMounted(false); return; }

    const from = box.getBoundingClientRect().height;
    if (prefersReducedMotion()) {
      animateOpacity(box, 1, 0, FADE_MS, () => setMounted(false));
      return;
    }
    animateNumber(from, 0, OPEN_MS, (v) => { box.style.height = `${v}px`; },
      () => setMounted(false));
  }, []);

  const toggle = () => {
    haptic("light");
    if (open) { close(); return; }
    setMounted(true);
    setOpen(true);
  };

  // Фокус переводим только при открытии формы — но не после отправки: там уже
  // нечего заполнять, и прыжок фокуса на скрытое поле сбил бы чтение.
  useEffect(() => {
    if (open && state === "idle") inputRef.current?.focus();
  }, [open, state]);

  // Esc закрывает — то же ожидание, что от шторки, хотя мы в потоке страницы.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); toggleRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  async function submit() {
    if (!canSend) return;
    setState("sending");
    setError("");
    try {
      await api("/leads", {
        method: "POST",
        body: JSON.stringify(buildPriceOfferBody(productId, url, price, comment)),
      });
      track("lead_created", { product_id: productId, source: "product" });
      haptic("rigid");
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить — попробуйте ещё раз");
      setState("error");
    }
  }

  const inputCls =
    "w-full rounded-xl2 border border-border bg-mutedbg px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent focus:bg-surface";

  return (
    <div className="mt-3">
      <button
        ref={toggleRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="price-offer-body"
        className="tap flex w-full items-center gap-3 rounded-xl2 border border-accent/25 bg-accent/[0.04] px-3.5 py-3 text-left"
      >
        {/* Ценовая гарантия — реальный триггер доверия, поэтому у блока свой
            акцентный значок, а не нейтральная серая полоса наравне с прочими
            второстепенными пунктами. */}
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/12 text-base text-accent"
        >
          🏷️
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-accentdark">Нашли дешевле?</span>
          <span className="mt-0.5 block text-[11px] text-muted">
            Пришлите ссылку — сверим цену
          </span>
        </span>
        {/* Стрелка поворачивается через inline-стиль: это состояние, а не
            анимация, и гашение системной анимации ему не мешает. */}
        <span
          aria-hidden
          className="shrink-0 text-muted"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          ⌄
        </span>
      </button>

      {/* Обёртка анимируется по высоте; overflow-hidden прячет содержимое,
          пока оно выше текущей высоты. */}
      <div
        id="price-offer-body"
        ref={boxRef}
        style={{ height: mounted ? undefined : 0, overflow: "hidden" }}
      >
        {mounted && (
          <div ref={bodyRef} className="pt-2">
            {state === "done" ? (
              <div className="rounded-xl2 border border-border bg-mutedbg p-4">
                <p className="text-[13px] font-semibold">✓ Запрос принят</p>
                <p className="mt-1 text-xs text-muted">
                  Менеджер сверит цену и напишет вам в Telegram.
                </p>
                <button
                  type="button"
                  onClick={() => { close(); toggleRef.current?.focus(); }}
                  className="tap mt-3 text-xs font-medium text-accent"
                >
                  Закрыть
                </button>
              </div>
            ) : (
              <div className="rounded-xl2 border border-border bg-mutedbg p-3.5">
                <label className="block text-[11px] font-medium text-muted" htmlFor="offer-url">
                  Ссылка на товар в другом магазине
                </label>
                <input
                  id="offer-url"
                  ref={inputRef}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="ozon.ru/product/…"
                  className={`mt-1.5 ${inputCls}`}
                />

                <label className="mt-3 block text-[11px] font-medium text-muted" htmlFor="offer-price">
                  Цена там, ₽ <span className="font-normal">— если знаете</span>
                </label>
                <input
                  id="offer-price"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="decimal"
                  placeholder="97 500"
                  className={`mt-1.5 ${inputCls}`}
                />
                {/* Выгоду называем, только когда она есть: подпись «дешевле на
                    0 ₽» на цене выше нашей выглядела бы издёвкой. */}
                {gap !== null && (
                  <p className="mt-1.5 text-[11px] text-muted">
                    Дешевле на {formatPrice(gap)}
                  </p>
                )}
                {priceError && price.trim() && (
                  <p className="mt-1.5 text-[11px] text-[#ff3b30]">{priceError}</p>
                )}

                <input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Комментарий (необязательно)"
                  className={`mt-3 ${inputCls}`}
                />

                {/* Ошибку ссылки показываем только после ввода: пустое поле при
                    открытии формы — не ошибка человека, а её начало. */}
                {urlError && url.trim() && (
                  <p className="mt-2 text-[11px] text-[#ff3b30]">{urlError}</p>
                )}
                {state === "error" && error && (
                  <p className="mt-2 text-[11px] text-[#ff3b30]">{error}</p>
                )}

                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSend}
                  className="tap mt-3 w-full rounded-xl2 bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {state === "sending" ? "Отправляем…" : "Отправить"}
                </button>
                <p className="mt-2 text-[11px] text-muted">
                  Цену не меняем автоматически — решение принимает менеджер.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
