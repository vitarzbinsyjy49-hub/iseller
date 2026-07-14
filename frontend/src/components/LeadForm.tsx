import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { formatPrice } from "../lib/format";

type Props = {
  productId?: number | null;
  productTitle?: string | null;
  productPrice?: number | null;
  source?: string;
  presetMessage?: string;
  onClose: () => void;
  onCreated?: () => void;
};

type Delivery = "pickup" | "delivery";

/** Bottom sheet «Оставить заявку»: имя, телефон, комментарий, способ получения.
 *  Выезжает снизу (260ms), backdrop с blur. Создаёт Lead в CRM.
 *  Рендерится через createPortal в document.body: fixed-оверлей позиционируется
 *  строго от viewport и не зависит от transform/overflow родителей
 *  (иначе на прокрученной странице шторка могла оказаться вне экрана). */
export default function LeadForm({
  productId, productTitle, productPrice, source = "product", presetMessage = "", onClose, onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState(presetMessage);
  const [delivery, setDelivery] = useState<Delivery>("pickup");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function submit() {
    if (state === "sending") return;
    if (!phone.trim()) { setError("Укажите телефон — менеджеру нужно с вами связаться"); return; }
    setState("sending");
    setError("");
    try {
      await api("/leads", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || null,
          phone: phone.trim() || null,
          product_id: productId ?? null,
          product_title: productTitle ?? null,
          message: message.trim() || null,
          source,
          delivery_method: delivery,
        }),
      });
      track("lead_created", { product_id: productId ?? null, source, delivery_method: delivery });
      setState("done");
      onCreated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить заявку");
      setState("error");
    }
  }

  const inputCls =
    "w-full rounded-xl2 border border-border bg-mutedbg px-4 py-3 text-sm outline-none transition-colors focus:border-accent focus:bg-surface";

  return createPortal(
    <div
      className="backdrop-in fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="sheet-in w-full max-w-md rounded-t-3xl bg-surface p-5 shadow-sheet safe-bottom sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />

        {state === "done" ? (
          <div className="pop-in py-6 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green/15 text-3xl">✅</div>
            <p className="mt-4 text-lg font-bold">Заявка отправлена</p>
            <p className="mt-1 text-sm text-muted">Менеджер скоро свяжется с вами. Статус — в разделе «Заявки».</p>
            <button onClick={onClose} className="tap mt-5 w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white">
              Готово
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">Оставить заявку</h3>
              <button onClick={onClose} className="tap flex h-8 w-8 items-center justify-center rounded-full bg-mutedbg text-muted">✕</button>
            </div>

            {productTitle && (
              <div className="mt-3 flex items-center justify-between rounded-xl2 bg-mutedbg px-4 py-3">
                <p className="line-clamp-1 pr-3 text-sm font-medium">{productTitle}</p>
                {productPrice != null && <p className="shrink-0 text-sm font-bold">{formatPrice(productPrice)}</p>}
              </div>
            )}

            <div className="mt-4 space-y-3">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ваше имя" className={inputCls} />
              <input
                value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="Телефон *" inputMode="tel" className={inputCls}
              />
              <textarea
                value={message} onChange={(e) => setMessage(e.target.value)}
                placeholder="Комментарий (необязательно)" rows={2}
                className={`${inputCls} resize-none`}
              />
            </div>

            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Способ получения</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <DeliveryOption
                active={delivery === "pickup"} onClick={() => setDelivery("pickup")}
                icon="🏬" title="Самовывоз" subtitle="Горбушка, Москва"
              />
              <DeliveryOption
                active={delivery === "delivery"} onClick={() => setDelivery("delivery")}
                icon="🚚" title="Доставка" subtitle="По Москве"
              />
            </div>

            {error && <p className="mt-3 text-sm text-[#ff3b30]">{error}</p>}

            <button
              onClick={submit} disabled={state === "sending"}
              className="tap mt-4 w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white transition-opacity disabled:opacity-50"
            >
              {state === "sending" ? "Отправляем…" : "Отправить заявку"}
            </button>
            <p className="mt-2 text-center text-[11px] text-muted">
              Нажимая кнопку, вы соглашаетесь с обработкой персональных данных
            </p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function DeliveryOption({
  active, onClick, icon, title, subtitle,
}: { active: boolean; onClick: () => void; icon: string; title: string; subtitle: string }) {
  return (
    <button
      onClick={onClick}
      className={`tap rounded-xl2 border-2 px-3 py-3 text-left transition-colors ${
        active ? "border-accent bg-accent/5" : "border-border bg-surface"
      }`}
    >
      <span className="text-lg">{icon}</span>
      <p className="mt-1 text-sm font-semibold">{title}</p>
      <p className="text-[11px] text-muted">{subtitle}</p>
    </button>
  );
}
