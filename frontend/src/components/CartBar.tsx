/** Sticky-панель корзины над нижней навигацией.
 *
 *  Появляется, только когда в корзине что-то есть, и только там, где не мешает:
 *  на самой корзине она была бы дублем, на карточке товара — встала бы поверх
 *  её собственной фиксированной CTA (см. shouldShowCartBar).
 *
 *  Safe-area учитывается РОВНО ОДИН раз — через ту же переменную
 *  --bottom-nav-height, что и cta-dock (index.css). Складывать env() и
 *  Telegram-инсет здесь нельзя: на iPhone это давало двойной отступ.
 *
 *  Сумма подписана как предварительная и намеренно НЕ сопровождается обещанием
 *  бесплатной доставки: такого бизнес-правила backend не отдаёт, а придуманный
 *  порог — это обещание за счёт магазина.
 */
import { useLocation, useNavigate } from "react-router-dom";
import { useCart } from "../lib/cart";
import { pluralItems, shouldShowCartBar } from "../lib/cartMath";
import { formatPrice } from "../lib/format";
import { track } from "../lib/analytics";
import { haptic } from "../lib/telegram";

export default function CartBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const cart = useCart();

  if (!shouldShowCartBar(pathname, cart.items_count)) return null;

  function open() {
    haptic("light");
    track("cart_open", { source: "cart_bar", items_count: cart.items_count });
    navigate("/cart");
  }

  return (
    // js-bottom-nav: при открытой клавиатуре скрывается тем же правилом, что и
    // навигация (html.kb-open в index.css) — иначе панель всплывает над клавой.
    // z-30: ниже навигации (z-40), поэтому перекрыть её не может.
    <div className="js-bottom-nav cart-dock fixed inset-x-0 z-30 px-4 lg:pointer-events-none lg:px-8">
      <div className="mx-auto max-w-md lg:pointer-events-auto lg:ml-auto lg:mr-0 lg:max-w-sm">
        <button
          onClick={open}
          className="pop-in tap flex w-full items-center gap-3 rounded-xl2 bg-surface p-2.5 pl-3 text-left shadow-float ring-1 ring-border"
        >
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
            <CartGlyph />
            <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
              {cart.items_count}
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-bold leading-5">
              {pluralItems(cart.items_count)} · {formatPrice(cart.estimated_total)}
            </span>
            <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted">
              Предварительно — итог подтвердит менеджер
            </span>
          </span>
          <span className="tap flex shrink-0 items-center gap-1 rounded-field bg-accent px-4 py-2.5 text-[13px] font-semibold text-white">
            Корзина
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </span>
        </button>
      </div>
    </div>
  );
}

/** Иконка сумки — в одном стиле со stroke-иконками нижней навигации. */
export function CartGlyph({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5.5 7.5h13l-1 12.5a1.5 1.5 0 0 1-1.5 1.4H8a1.5 1.5 0 0 1-1.5-1.4z" />
      <path d="M9 9V6a3 3 0 0 1 6 0v3" />
    </svg>
  );
}
