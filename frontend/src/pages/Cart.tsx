/** Корзина и оформление одной общей заявки.
 *
 *  Корзина — это НЕ оплата и НЕ бронь: список выбранной техники, который уходит
 *  менеджеру одной заявкой. Этот смысл проговаривается на экране прямым текстом
 *  («Наличие, комплектацию и итоговую стоимость подтвердит менеджер») — иначе
 *  привычная механика корзины обещает покупателю то, чего магазин не делает.
 *
 *  Состояния экрана: загрузка / пусто / ошибка+повтор / есть изменения цен /
 *  есть недоступные позиции / отправка / успех. Ни одного alert(): всё либо
 *  на экране, либо тостом.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { track } from "../lib/analytics";
import { formatPrice } from "../lib/format";
import { haptic, openExternalLink } from "../lib/telegram";
import { usePublicConfig } from "../lib/appConfig";
import { useAuthStore } from "../store/auth";
import { toast } from "../lib/toast";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard, { ProductImage } from "../components/ProductCard";
import { QuantityStepper } from "../components/QuantityStepper";
import { ErrorState } from "../components/StateViews";
import { CartGlyph } from "../components/CartBar";
import {
  checkoutCart, clearCart, hydrateCart, removeCartItem, setItemQuantity, useCart,
} from "../lib/cart";
import {
  type CartItemRow, newIdempotencyKey, pluralItems, validateCheckout,
} from "../lib/cartMath";

type Fulfillment = "pickup" | "delivery" | "consult";
type LoadState = "loading" | "ready" | "error";
type SubmitState = "idle" | "sending" | "error";

type Success = { number: string; itemsCount: number; total: number | null };

export default function Cart() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const cart = useCart();
  const user = useAuthStore((s) => s.user);
  const config = usePublicConfig();

  const [load, setLoad] = useState<LoadState>("loading");
  const [busyItem, setBusyItem] = useState<number | null>(null);
  const [success, setSuccess] = useState<Success | null>(null);

  const refresh = () => {
    setLoad("loading");
    // Цены и наличие могли измениться, пока корзина лежала: открытие экрана —
    // единственный момент, когда мы обязаны их перечитать.
    hydrateCart()
      .then(() => setLoad("ready"))
      .catch(() => setLoad("error"));
  };

  useEffect(() => {
    track("cart_open", { source: params.get("from") || "direct" });
    refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(item: CartItemRow, quantity: number) {
    setBusyItem(item.id);
    haptic("light");
    try {
      if (quantity <= 0) {
        track("cart_remove", { product_id: item.product_id });
        await removeCartItem(item.id);
      } else {
        track("cart_quantity_change", { product_id: item.product_id, quantity });
        await setItemQuantity(item.id, quantity);
      }
    } catch {
      toast("Не удалось обновить корзину", "error");
    } finally {
      setBusyItem(null);
    }
  }

  async function onClear() {
    try {
      await clearCart();
      toast("Корзина очищена");
    } catch {
      toast("Не удалось очистить корзину", "error");
    }
  }

  if (success) {
    return <SuccessView result={success} managerUrl={config.manager_retail_url} />;
  }

  if (load === "error" && cart.items.length === 0) {
    return (
      <div className="mx-auto max-w-md lg:max-w-3xl">
        <h1 className="text-2xl font-bold">Корзина</h1>
        <div className="mt-6"><ErrorState message="Не удалось загрузить корзину" onRetry={refresh} /></div>
      </div>
    );
  }

  if (load === "loading" && cart.items.length === 0) {
    return (
      <div className="mx-auto max-w-md lg:max-w-3xl">
        <h1 className="text-2xl font-bold">Корзина</h1>
        <div className="mt-4 space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-24 rounded-xl2" />)}
        </div>
      </div>
    );
  }

  if (cart.items.length === 0) return <EmptyCart />;

  return (
    <div className="mx-auto max-w-md lg:max-w-3xl">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Корзина</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            {pluralItems(cart.items_count)}
            {cart.positions_count !== cart.items_count && ` · ${cart.positions_count} позиц.`}
          </p>
        </div>
        <button
          onClick={onClear}
          className="tap shrink-0 text-xs font-medium text-muted transition-colors hover:text-[#ff3b30]"
        >
          Очистить
        </button>
      </div>

      {/* Изменения цены и недоступные позиции — предупреждения, а не молчание:
          иначе пользователь узнаёт о них уже от менеджера. */}
      {cart.has_price_changes && (
        <Notice tone="info">
          Цены обновились с момента добавления. В сумме — актуальные значения из каталога.
        </Notice>
      )}
      {cart.has_unavailable && (
        <Notice tone="warn">
          Часть товаров сейчас недоступна. Удалите их или напишите менеджеру — заявку
          с ними отправить нельзя.
        </Notice>
      )}

      <div className="stagger mt-3 space-y-2.5">
        {cart.items.map((item) => (
          <CartRow
            key={item.id}
            item={item}
            busy={busyItem === item.id}
            onQuantity={(q) => change(item, q)}
            onOpen={() => item.product_id && navigate(`/product/${item.product_id}`)}
          />
        ))}
      </div>

      <div className="mt-4 rounded-xl2 bg-surface p-4 shadow-soft">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[15px] font-semibold">Предварительная сумма</span>
          <span className="text-xl font-bold tabular-nums">{formatPrice(cart.estimated_total)}</span>
        </div>
        <p className="mt-1 text-[12px] leading-4 text-muted">
          Наличие, комплектацию и итоговую стоимость подтвердит менеджер.
          Это не оплата и не бронирование.
        </p>
      </div>

      <button
        onClick={() => {
          track("continue_shopping", { source: "cart" });
          navigate("/catalog");
        }}
        className="tap mt-3 w-full rounded-xl2 bg-surface py-3 text-sm font-semibold text-accent shadow-soft"
      >
        Продолжить покупки
      </button>

      <CheckoutBlock
        cartTotal={cart.estimated_total}
        itemsCount={cart.items_count}
        blocked={cart.has_unavailable}
        defaultName={user?.first_name ?? ""}
        requirePhone={!user?.username}
        telegramUsername={user?.username ?? null}
        autoOpen={params.get("checkout") === "1"}
        onSuccess={setSuccess}
        onRefresh={refresh}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ строка --- */
function CartRow({
  item, busy, onQuantity, onOpen,
}: {
  item: CartItemRow; busy: boolean; onQuantity: (q: number) => void; onOpen: () => void;
}) {
  const unavailable = !item.orderable;
  return (
    <div
      className={`card-appear flex gap-3 rounded-xl2 bg-surface p-3 shadow-soft ${
        unavailable ? "opacity-75 ring-1 ring-[#ffd9d5]" : ""
      }`}
    >
      <button onClick={onOpen} className="h-20 w-20 shrink-0 overflow-hidden rounded-xl" aria-label={item.title}>
        <ProductImage src={item.image} title={item.title} category={item.category} className="h-full w-full" compact />
      </button>

      <div className="min-w-0 flex-1">
        <button onClick={onOpen} className="block w-full text-left">
          <p className="line-clamp-2 text-[13px] font-medium leading-[1.35]">{item.title}</p>
        </button>

        {/* SKU — служебная строка: показываем мелко и только когда он есть. */}
        {item.sku && <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">Арт. {item.sku}</p>}

        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[15px] font-bold tabular-nums">
            {item.price != null ? formatPrice(item.price) : "—"}
          </span>
          {/* Старую цену показываем только когда она реально другая — иначе это
              шум, который выглядит как скидка. */}
          {item.price_changed && item.added_price != null && (
            <span className="text-[11px] text-muted line-through tabular-nums">
              {formatPrice(item.added_price)}
            </span>
          )}
        </div>
        {item.price_changed && (
          <p className="mt-0.5 text-[11px] font-medium text-orange">Цена обновилась</p>
        )}
        {item.availability_note && (
          <p className={`mt-0.5 text-[11px] font-medium ${unavailable ? "text-[#ff3b30]" : "text-muted"}`}>
            {item.availability_note}
          </p>
        )}

        <div className="mt-2 flex items-center justify-between gap-3">
          {unavailable ? (
            <button
              onClick={() => onQuantity(0)}
              className="tap rounded-field bg-mutedbg px-3 py-2 text-[12px] font-semibold text-text"
            >
              Удалить
            </button>
          ) : (
            <div className="w-[7.5rem]">
              <QuantityStepper
                quantity={item.quantity}
                max={item.max_quantity}
                busy={busy}
                size="sm"
                onChange={onQuantity}
                ariaLabel={`Количество: ${item.title}`}
              />
            </div>
          )}
          <span className="shrink-0 text-[13px] font-semibold tabular-nums text-muted">
            {item.orderable ? formatPrice(item.line_total) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "info" | "warn"; children: React.ReactNode }) {
  const cls = tone === "warn"
    ? "bg-[#fff1ef] text-[#b4342a]"
    : "bg-accent/[0.08] text-accentdark";
  return <p className={`fade-in mt-3 rounded-xl2 px-4 py-3 text-[12px] leading-4 ${cls}`}>{children}</p>;
}

/* ---------------------------------------------------------------- checkout --- */
function CheckoutBlock({
  cartTotal, itemsCount, blocked, defaultName, requirePhone, telegramUsername,
  autoOpen, onSuccess, onRefresh,
}: {
  cartTotal: number;
  itemsCount: number;
  blocked: boolean;
  defaultName: string;
  requirePhone: boolean;
  telegramUsername: string | null;
  autoOpen: boolean;
  onSuccess: (s: Success) => void;
  onRefresh: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [phone, setPhone] = useState("");
  const [comment, setComment] = useState("");
  const [fulfillment, setFulfillment] = useState<Fulfillment>("pickup");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState("");
  // Ключ идемпотентности живёт до УСПЕХА: повтор после таймаута обязан
  // переиспользовать его, иначе ретрай создаст вторую заявку.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (autoOpen && !started) {
      setStarted(true);
      track("checkout_start", { source: "buy_now", items_count: itemsCount });
    }
  }, [autoOpen, started, itemsCount]);

  async function submit() {
    if (state === "sending") return;            // защита от двойного нажатия
    const problem = validateCheckout({ phone, consent, requirePhone });
    if (problem) { setError(problem); return; }
    if (blocked) {
      setError("Сначала уберите недоступные товары");
      return;
    }

    setState("sending");
    setError("");
    track("checkout_submit", { items_count: itemsCount, fulfillment });
    try {
      const result = await checkoutCart({
        name: name.trim(), phone: phone.trim(), fulfillment_type: fulfillment,
        comment: comment.trim(), consent, idempotency_key: idempotencyKey,
      });
      haptic("light");
      onSuccess({
        number: result.lead.public_number,
        itemsCount: result.lead.items_count,
        total: result.lead.estimated_total,
      });
      // Ключ отработал — следующая заявка получит новый.
      setIdempotencyKey(newIdempotencyKey());
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      setError(
        conflict
          ? "Часть товаров стала недоступна — обновите корзину и попробуйте снова"
          : e instanceof ApiError
            ? e.message
            : "Не удалось отправить заявку. Проверьте связь и попробуйте ещё раз",
      );
      setState("error");
      track("checkout_error", { status: e instanceof ApiError ? e.status : 0 });
      if (conflict) onRefresh();
      return;
    }
    setState("idle");
  }

  const inputCls =
    "w-full rounded-xl2 border border-border bg-mutedbg px-4 py-3 text-sm outline-none transition-colors focus:border-accent focus:bg-surface";

  return (
    <div className="mt-4 rounded-xl2 bg-surface p-4 shadow-soft">
      <h2 className="text-[17px] font-bold">Оформление</h2>
      <p className="mt-0.5 text-[12px] text-muted">
        Отправим одну заявку по всей корзине. Менеджер свяжется и всё уточнит.
      </p>

      <div className="mt-3 space-y-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ваше имя" className={inputCls} />
        <input
          value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel"
          placeholder={requirePhone ? "Телефон *" : "Телефон (необязательно)"}
          className={inputCls}
        />
        {/* Контакт, который уже известен, не просим вводить второй раз. */}
        {telegramUsername && (
          <p className="text-[11px] text-muted">
            Менеджер сможет ответить в Telegram: <span className="font-medium text-text">@{telegramUsername}</span>
          </p>
        )}
        <textarea
          value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
          placeholder="Комментарий (необязательно)" className={`${inputCls} resize-none`}
        />
      </div>

      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Способ получения</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <FulfillmentOption active={fulfillment === "pickup"} onClick={() => setFulfillment("pickup")}
          icon="🏬" title="Самовывоз" subtitle="Горбушка" />
        <FulfillmentOption active={fulfillment === "delivery"} onClick={() => setFulfillment("delivery")}
          icon="🚚" title="Доставка" subtitle="По Москве" />
        <FulfillmentOption active={fulfillment === "consult"} onClick={() => setFulfillment("consult")}
          icon="💬" title="Уточнить" subtitle="С менеджером" />
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[color:rgb(var(--app-accent))]"
        />
        <span className="text-[12px] leading-4 text-muted">
          Согласен на обработку персональных данных и связь по заявке
        </span>
      </label>

      {error && (
        <p role="alert" className="mt-3 rounded-xl2 bg-[#fff1ef] px-3 py-2 text-[13px] text-[#b4342a]">
          {error}
        </p>
      )}

      <button
        onClick={submit}
        disabled={state === "sending"}
        className="tap mt-4 w-full rounded-xl2 bg-accent py-3.5 text-white transition-opacity disabled:opacity-50"
      >
        <span className="block text-[15px] font-bold leading-5">
          {state === "sending" ? "Отправляем…" : "Отправить заявку"}
        </span>
        <span className="block text-[11px] font-medium text-white/80">
          {pluralItems(itemsCount)} · предварительно {formatPrice(cartTotal)}
        </span>
      </button>
    </div>
  );
}

function FulfillmentOption({
  active, onClick, icon, title, subtitle,
}: { active: boolean; onClick: () => void; icon: string; title: string; subtitle: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`tap rounded-xl2 border-2 px-2 py-2.5 text-left transition-colors ${
        active ? "border-accent bg-accent/5" : "border-border bg-surface"
      }`}
    >
      <span className="text-base">{icon}</span>
      <p className="mt-0.5 text-[12px] font-semibold leading-4">{title}</p>
      <p className="truncate text-[10px] leading-3 text-muted">{subtitle}</p>
    </button>
  );
}

/* ------------------------------------------------------------------ успех --- */
function SuccessView({ result, managerUrl }: { result: Success; managerUrl?: string }) {
  const navigate = useNavigate();
  useEffect(() => { track("checkout_success", { items_count: result.itemsCount }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto max-w-md pt-8 text-center lg:max-w-lg">
      <div className="pop-in mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green/15 text-3xl">
        ✅
      </div>
      <p className="mt-4 text-xl font-bold">Заявка {result.number} отправлена</p>
      <p className="mx-auto mt-2 max-w-[300px] text-sm text-muted">
        Менеджер подтвердит наличие, комплектацию и итоговую стоимость.
      </p>
      {result.total != null && (
        <p className="mt-3 text-[13px] text-muted">
          {pluralItems(result.itemsCount)} · предварительно{" "}
          <span className="font-semibold text-text">{formatPrice(result.total)}</span>
        </p>
      )}

      <div className="mx-auto mt-6 flex max-w-xs flex-col gap-2">
        <button
          onClick={() => navigate("/requests")}
          className="tap rounded-xl2 bg-accent py-3 text-sm font-semibold text-white"
        >
          Мои заявки
        </button>
        <button
          onClick={() => { track("continue_shopping", { source: "checkout_success" }); navigate("/catalog"); }}
          className="tap rounded-xl2 bg-surface py-3 text-sm font-semibold text-accent shadow-soft"
        >
          Продолжить покупки
        </button>
        <button
          onClick={() => { if (!openExternalLink(managerUrl)) navigate("/ai"); }}
          className="tap rounded-xl2 py-3 text-sm font-medium text-muted"
        >
          💬 Написать менеджеру
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ пустой экран --- */
function EmptyCart() {
  const navigate = useNavigate();
  const [recent, setRecent] = useState<TCard[] | null>(null);
  const [hits, setHits] = useState<TCard[] | null>(null);

  useEffect(() => {
    api<{ cards?: TCard[] }>("/catalog/recently-viewed?limit=8")
      .then((d) => setRecent(d.cards ?? [])).catch(() => setRecent([]));
    api<{ hot?: TCard[] }>("/catalog/feed")
      .then((d) => setHits(d.hot ?? [])).catch(() => setHits([]));
  }, []);

  return (
    <div className="mx-auto max-w-md lg:max-w-5xl">
      <h1 className="text-2xl font-bold">Корзина</h1>

      <div className="fade-in mt-8 text-center">
        <span className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-mutedbg text-muted">
          <CartGlyph className="h-9 w-9" />
        </span>
        <p className="mt-4 text-[15px] font-bold">В корзине пока ничего нет</p>
        <p className="mx-auto mt-1 max-w-[300px] text-sm text-muted">
          Добавьте технику из каталога — отправим одной заявкой, менеджер подтвердит наличие и цену.
        </p>
        <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
          <button
            onClick={() => {
              track("empty_state_action_clicked", { source: "cart_catalog" });
              navigate("/catalog");
            }}
            className="tap rounded-xl2 bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accentdark"
          >
            Перейти в каталог
          </button>
          <button
            onClick={() => {
              track("empty_state_action_clicked", { source: "cart_ai" });
              navigate("/ai");
            }}
            className="tap rounded-xl2 bg-surface px-5 py-2.5 text-sm font-semibold text-accent shadow-soft"
          >
            ✨ Подобрать с AI
          </button>
        </div>
      </div>

      {recent && recent.length >= 2 && <Suggestions title="Вы недавно смотрели" cards={recent} />}
      {hits && hits.length >= 2 && <Suggestions title="Хиты продаж" cards={hits} />}
    </div>
  );
}

function Suggestions({ title, cards }: { title: string; cards: TCard[] }) {
  return (
    <div className="mt-8">
      <h2 className="text-[17px] font-bold leading-5">{title}</h2>
      <div className="no-scrollbar stagger -mx-4 mt-3 flex gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:gap-4 lg:overflow-visible lg:px-0 lg:pb-0">
        {cards.slice(0, 8).map((c) => <ProductCard key={c.id} card={c} compact />)}
      </div>
    </div>
  );
}
