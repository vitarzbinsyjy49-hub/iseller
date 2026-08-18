import { useState } from "react";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { formatPrice } from "../lib/format";
import { SheetShell } from "./ScenarioSheet";
import { FormError, TextAreaField, TextField } from "./Field";
import { Icon, type IconName } from "./icons";
import { AnimatedCheck } from "./AnimatedCheck";

/** Отдельной константой — по этому id форма уводит фокус на телефон. */
const PHONE_ID = "lead-phone";

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
 *  Выезжает снизу (260ms), backdrop меняет только opacity. Создаёт Lead в CRM.
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
  // Ошибка поля и ошибка формы разделены так же, как в оформлении корзины:
  // «укажите телефон» принадлежит полю, «не удалось отправить» — форме.
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function submit() {
    if (state === "sending") return;
    if (!phone.trim()) {
      setPhoneError("Укажите телефон — менеджеру нужно с вами связаться");
      document.getElementById(PHONE_ID)?.focus();
      return;
    }
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

  return (
    <SheetShell onClose={onClose} labelledBy="lead-form-title" panelClassName="p-5">
      {(close) => (
        <>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />

        {state === "done" ? (
          <div className="py-6 text-center">
            <AnimatedCheck />
            <p id="lead-form-title" className="mt-4 text-lg font-bold">Заявка отправлена</p>
            <p className="mt-1 text-sm text-muted">Менеджер скоро свяжется с вами. Статус — в разделе «Заявки».</p>
            <button onClick={() => close()} className="tap mt-5 w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white">
              Готово
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h3 id="lead-form-title" className="text-lg font-bold">Оставить заявку</h3>
              <button
                onClick={() => close()}
                aria-label="Закрыть"
                className="tap -mr-1.5 flex h-11 w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mutedbg text-muted">
                  <Icon name="close" className="h-4 w-4" strokeWidth={2} />
                </span>
              </button>
            </div>

            {productTitle && (
              <div className="mt-3 flex items-center justify-between rounded-xl2 bg-mutedbg px-4 py-3">
                <p className="line-clamp-1 pr-3 text-sm font-medium">{productTitle}</p>
                {productPrice != null && <p className="shrink-0 text-sm font-bold">{formatPrice(productPrice)}</p>}
              </div>
            )}

            <div className="mt-4 space-y-3">
              <TextField
                id="lead-name" label="Ваше имя" autoComplete="name"
                value={name} onChange={(e) => setName(e.target.value)}
              />
              <TextField
                id={PHONE_ID} label="Телефон" type="tel" inputMode="tel" autoComplete="tel" required
                value={phone} error={phoneError}
                onBlur={() => {
                  if (!phone.trim()) setPhoneError("Укажите телефон — менеджеру нужно с вами связаться");
                }}
                onChange={(e) => { setPhone(e.target.value); if (phoneError) setPhoneError(null); }}
              />
              <TextAreaField
                id="lead-message" label="Комментарий" hint="Необязательно" rows={2}
                value={message} onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Способ получения</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <DeliveryOption
                active={delivery === "pickup"} onClick={() => setDelivery("pickup")}
                icon="store" title="Самовывоз" subtitle="Горбушка, Москва"
              />
              <DeliveryOption
                active={delivery === "delivery"} onClick={() => setDelivery("delivery")}
                icon="truck" title="Доставка" subtitle="По Москве"
              />
            </div>

            {error && <FormError>{error}</FormError>}

            <button
              onClick={submit} disabled={state === "sending"}
              className="tap mt-4 w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {state === "sending" ? "Отправляем…" : "Отправить заявку"}
            </button>
            <p className="mt-2 text-center text-[12px] text-muted">
              Нажимая кнопку, вы соглашаетесь с обработкой персональных данных
            </p>
          </>
        )}
        </>
      )}
    </SheetShell>
  );
}

function DeliveryOption({
  active, onClick, icon, title, subtitle,
}: { active: boolean; onClick: () => void; icon: IconName; title: string; subtitle: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`tap rounded-xl2 border-2 px-3 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${
        active ? "border-accent bg-accent/5" : "border-border bg-surface"
      }`}
    >
      <Icon name={icon} className={`h-5 w-5 ${active ? "text-accent" : "text-muted"}`} />
      <p className="mt-1.5 text-sm font-semibold">{title}</p>
      <p className="text-[12px] text-muted">{subtitle}</p>
    </button>
  );
}
