import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type UIEvent as ReactUIEvent,
  type MouseEvent, type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { ProductCard as TCard } from "./ai/types";
import { formatPrice, discountPct } from "../lib/format";
import { imagePaddingClass } from "../lib/viewport";
import { useFavorite } from "../lib/favorites";
import { haptic } from "../lib/telegram";
import { toast } from "../lib/toast";
import { track } from "../lib/analytics";
import { indexFromScroll, isSlideMounted, isTapGesture } from "../lib/carousel";
import { animatePulse, animateScrollTo, transitionDuration } from "../lib/motion";
import { enterGridRefCallback, enterRefCallback } from "../lib/useEnter";
import { useCartSwapOut } from "../lib/useCartSwap";
import { addToCart, removeCartItem, setItemQuantity, useCartEntry } from "../lib/cart";
import { availabilityText, availabilityTone, canAddToCart } from "../lib/cartMath";
import { cardBadges } from "../lib/cardBadges";
import { QuantityStepper } from "./QuantityStepper";
import { CART_SWAP_DX_PX } from "../lib/useCartSwap";
import { preloadRoute } from "../lib/routePreload";
import { Icon } from "./icons";

const MAX_CARD_IMAGES = 10;

type Props = {
  card: TCard;
  compact?: boolean;
  /** Вызывается перед переходом на карточку (напр. лог recommendation_click). */
  onOpen?: (card: TCard) => void;
};

/** Нейтральный силуэт категории для товара без фото. Спокойный серый, без
 *  ярких пастелей и без emoji-как-товара: заглушка не притворяется фотографией. */
function CategorySilhouette({ category }: { category?: string | null }) {
  const s = {
    fill: "none" as const, stroke: "currentColor", strokeWidth: 1.4,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  const glyph = (() => {
    switch ((category ?? "").toLowerCase()) {
      case "смартфоны":
        return <><rect x="8" y="3" width="8" height="18" rx="2.2" /><path d="M11 18.5h2" /></>;
      case "ноутбуки":
        return <><rect x="5" y="5" width="14" height="9" rx="1" /><path d="M3 17.5h18l-1.4 2.2H4.4z" /></>;
      case "планшеты":
        return <><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M11 17h2" /></>;
      case "наушники":
        return <><path d="M5 13v-1a7 7 0 0 1 14 0v1" /><rect x="3.5" y="12.5" width="3.4" height="6.5" rx="1.6" /><rect x="17.1" y="12.5" width="3.4" height="6.5" rx="1.6" /></>;
      case "консоли":
        return <><rect x="3" y="8" width="18" height="8" rx="4" /><path d="M6.5 11v2M5.5 12h2" /><circle cx="16.5" cy="11.4" r=".7" /><circle cx="18.2" cy="13" r=".7" /></>;
      case "часы":
        return <><rect x="7.5" y="7.5" width="9" height="9" rx="2.4" /><path d="M12 10.2V12l1.6 1M9.5 7.5 10 4h4l.5 3.5M9.5 16.5 10 20h4l.5-3.5" /></>;
      case "красота":  // фены, стайлеры, выпрямители
        return <><path d="M4 9h8.5A2.75 2.75 0 1 0 9.75 6" /><path d="M4 13h11a2.75 2.75 0 1 1-2.75 3" /></>;
      case "бытовая техника":  // пылесосы, климат
        return <><path d="M5 20V9.5a4.5 4.5 0 0 1 4.5-4.5H12" /><rect x="12" y="3.5" width="7" height="5" rx="1.6" /><rect x="3" y="16" width="6" height="4.5" rx="1.4" /></>;
      default:
        return <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="8.8" cy="10" r="1.5" /><path d="m5 18 4.6-4.4L13 17l2.8-2.7L20 18" /></>;
    }
  })();
  return <svg viewBox="0 0 24 24" className="h-9 w-9 text-[#b6bcc5]" aria-hidden {...s}>{glyph}</svg>;
}

/** Медиа-контейнер товара. Единый во всех местах (карточка, галерея).
 *  - Реальное фото: object-contain по центру на фоне поверхности — товар
 *    помещается целиком, верх/низ не обрезаются; отступ по реальным пропорциям.
 *  - Нет/битое фото: спокойный серо-белый фон + нейтральный силуэт категории
 *    (не emoji, не яркая пастель), UI не прыгает, broken-image icon не виден.
 *  - compact (узкая карточка в ленте): подпись «Фото скоро появится» скрываем.
 *
 *  `bleed` — снимок со СВОИМ фоном, который должен доходить до краёв карточки.
 *
 *  Обычные товарные фото вырезаны на белом, и отступ им нужен: без него товар
 *  упирается в край. У снимка с запечённым фоном всё наоборот — отступ рисует
 *  вокруг него белую рамку, а `object-contain` при несовпадении пропорций
 *  добавляет ещё и полосы. Замер на легендарной карточке: фото 4:3 в квадрате
 *  160×160 занимало 61% площади, сверху и снизу по 26px белого, и шов между
 *  сиреневым фоном снимка и белым фоном карточки был виден. */
export function ProductImage({
  src, title, category, className = "", compact = false, bleed = false,
}: { src?: string; title: string; category?: string | null; className?: string; compact?: boolean; bleed?: boolean }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [pad, setPad] = useState<"p-3" | "p-2">("p-3");
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const showImg = src && failedSrc !== src;
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={
        showImg
          ? { background: "rgb(var(--app-surface))" }
          : { background: "linear-gradient(160deg,#f5f6f8,#e8eaee)" }
      }
    >
      {showImg ? (
        <img
          src={src}
          alt={title}
          loading="lazy"
          decoding="async"
          className={`product-image h-full w-full object-center ${
            bleed ? "object-cover" : `object-contain ${pad}`
          } ${loadedSrc === src ? "product-image-loaded" : ""}`}
          onError={() => setFailedSrc(src ?? null)}
          onLoad={(e) => {
            const img = e.currentTarget;
            setPad(imagePaddingClass(img.naturalWidth, img.naturalHeight));
            setLoadedSrc(src ?? null);
          }}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-3 text-center">
          <CategorySilhouette category={category} />
          {!compact && <span className="text-[11px] font-medium text-[#aeb4bd]">Фото скоро появится</span>}
        </div>
      )}
    </div>
  );
}

/** Карусель фото на карточке товара (как в Яндекс Лавке): горизонтальный свайп
 *  + точки. Свайп НЕ открывает товар (подавляем клик), тап — открывает.
 *
 *  Листание делает НАТИВНЫЙ горизонтальный скролл со scroll-snap, а не JS: раньше
 *  на каждый pointermove вызывался setState со сдвигом в пикселях, и React
 *  перерисовывал карусель на каждый пиксель движения пальца — при ленте из
 *  десятка карточек это давало заметные рывки. Теперь во время жеста React не
 *  рендерит вообще ничего: инерцию, снап и подтормаживание на краях считает
 *  компоновщик браузера (та же механика, что в галерее ProductDetails).
 *  onScroll меняет состояние только когда реально сменился активный слайд.
 *
 *  Вертикальный скролл страницы не блокируется: у overflow-x контейнера
 *  вертикальный жест по умолчанию уходит родителю. Монтируются только активный
 *  слайд и соседи (lazy). 0–1 фото — обычная карточка без точек и без скролла. */
function CardCarousel({
  id, images, title, category, compact, onOpen, bleed,
}: {
  id: number; images: string[]; title: string; category?: string | null;
  compact?: boolean; onOpen: () => void; bleed?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Начало жеста: позиция пальца + scrollLeft на тот момент. Только ref —
  // ничего из этого не должно вызывать перерисовку.
  const gestureRef = useRef<{ x: number; y: number; scroll: number } | null>(null);
  const tapRef = useRef(false);
  // Индекс, к которому мы сами проскроллили по клику на точку: приходящий следом
  // onScroll не должен считаться свайпом пользователя.
  const programmaticRef = useRef<number | null>(null);

  const n = images.length;
  const hasCarousel = n >= 2;

  // Сброс активного слайда при смене товара или набора фото.
  useEffect(() => {
    setIndex(0);
    scrollRef.current?.scrollTo({ left: 0 });
  }, [id, n, images[0]]);

  function goToDot(to: number) {
    const el = scrollRef.current;
    if (!el || to === index) return;
    track("product_gallery_dot_clicked",
      { product_id: id, from_index: index, to_index: to, image_count: n });
    programmaticRef.current = to;
    // Своя анимация вместо browser smooth: он рисуется композитором и в части
    // WebView молча не срабатывает — фото менялось рывком там, где мы обещали
    // проезд. При «уменьшить движение» transitionDuration отдаёт короткое
    // время, и переход остаётся заметным, но без пролёта. См. lib/motion.
    animateScrollTo(el, to * el.clientWidth, transitionDuration(320));
    setIndex(to);
  }

  function onScroll(e: ReactUIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const i = indexFromScroll(el.scrollLeft, el.clientWidth, n);
    if (i === index) return;
    if (programmaticRef.current === i) programmaticRef.current = null;
    else {
      track("product_gallery_swiped",
        { product_id: id, from_index: index, to_index: i, image_count: n });
    }
    setIndex(i);
  }

  function onPointerDown(e: ReactPointerEvent) {
    preloadRoute("/product");
    gestureRef.current = { x: e.clientX, y: e.clientY, scroll: scrollRef.current?.scrollLeft ?? 0 };
    tapRef.current = false;
  }
  function onPointerUp(e: ReactPointerEvent) {
    const s = gestureRef.current;
    gestureRef.current = null;
    if (!s) return;
    tapRef.current = isTapGesture(
      e.clientX - s.x, e.clientY - s.y, (scrollRef.current?.scrollLeft ?? 0) - s.scroll,
    );
  }
  function onClick() {
    // Клавиатура/скринридер шлют click без pointer-жеста — там gestureRef пуст
    // и tapRef false, поэтому открытие с клавиатуры отдельно в onKeyDown.
    if (tapRef.current) { tapRef.current = false; onOpen(); }
  }

  return (
    // isolate: во время инерционного свайпа iOS/WebView композитит скролл-
    // контейнер и рисует его ПОВЕРХ абсолютных соседей карточки (бейдж «Хит»,
    // сердечко) вопреки z-index — они пропадали на время жеста, а на
    // перелистанном за край фото было видно, как лайк уходит ПОД снимок.
    // Отдельный контекст наложения запирает скролл внутри карусели, и внешние
    // оверлеи снова рисуются над ним.
    <div className="relative isolate">
      <div
        ref={scrollRef}
        role="button"
        tabIndex={0}
        aria-label={hasCarousel ? `${title}. Фото ${index + 1} из ${n}` : title}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { gestureRef.current = null; tapRef.current = false; }}
        onScroll={hasCarousel ? onScroll : undefined}
        // display задаём в ветках, а не в общей части: block и flex — одно и то
        // же CSS-свойство, и порядок в строке классов на победителя не влияет.
        className={`w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          hasCarousel
            ? "flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : "block overflow-hidden"
        }`}
      >
        {hasCarousel ? (
          images.map((src, i) => (
            <div key={i} className="w-full flex-none snap-center">
              <ProductImage
                src={isSlideMounted(i, index) ? src : undefined}
                title={title} category={category} className="aspect-square w-full" compact={compact} bleed={bleed}
              />
            </div>
          ))
        ) : (
          <ProductImage src={images[0]} title={title} category={category} className="aspect-square w-full" compact={compact} bleed={bleed} />
        )}
      </div>

      {/* Точки-индикаторы (как в Лавке): по центру внизу фото, до 10 шт. Кнопки —
          отдельные от свайп-области (не вложенные), чтобы DOM был валиден.

          Сама точка — 6px, попасть по ней пальцем нельзя: правило просит 44px.
          Целиком 44 здесь недостижимо — десять точек по 44px не помещаются в
          карточку шириной 160px, а полоса такой высоты над фото съела бы свайп
          (кнопки лежат вне скролл-контейнера, жест по ним галерею не листает).
          Компромисс: кнопка 28px в высоту и прозрачные поля по бокам, видимое
          не изменилось. Основной жест здесь свайп, точки — вспомогательный. */}
      {hasCarousel && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center">
          {images.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Показать фото ${i + 1}`}
              aria-current={i === index}
              onClick={(e) => { e.stopPropagation(); goToDot(i); }}
              className="pointer-events-auto flex h-7 shrink-0 items-end justify-center px-1 pb-2 outline-none"
            >
              <span
                className={`block h-1.5 rounded-full shadow-soft transition-[width,background-color] duration-150 ${
                  i === index ? "w-4 bg-white" : "w-1.5 bg-white/60"
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Сердечко «в избранное»: серверное хранение, оптимистичный тоггл с откатом,
 *  тактильный отклик, toast и короткая scale-анимация. stopPropagation —
 *  тап по сердцу не открывает карточку товара. */
export function FavButton({
  id, className = "", visualClassName = "h-8 w-8 bg-white shadow-card",
}: {
  id: number;
  /** Позиционирование внешней (нажимаемой) области. Размер её не задавать. */
  className?: string;
  /** Видимый кружок: размер, фон, рамка. Область нажатия всегда 44×44. */
  visualClassName?: string;
}) {
  const [fav, toggle, busy] = useFavorite(id);
  const heartRef = useRef<SVGSVGElement>(null);

  async function onClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;             // антидабл-клик
    haptic("light");
    if (heartRef.current) animatePulse(heartRef.current);
    try {
      const nowFav = await toggle();
      toast(nowFav ? "Добавлено в избранное" : "Удалено из избранного");
    } catch {
      toast("Не удалось обновить избранное", "error");
    }
  }

  return (
    // Кружок остался 32px, нажимаемая область — 44px: белый круг во всю зону
    // нажатия закрыл бы четверть фото на узкой карточке. Растёт прозрачная
    // обёртка, видимое не меняется. Позицию компенсирует вызывающая сторона
    // (right-0.5/top-0.5 вместо right-2/top-2 — круг остаётся на месте).
    <button
      type="button"
      onClick={onClick}
      aria-pressed={fav}
      aria-label={fav ? "Убрать из избранного" : "В избранное"}
      className={`tap flex h-11 w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
    >
      <span className={`flex items-center justify-center rounded-full ${visualClassName}`}>
        <svg ref={heartRef} viewBox="0 0 24 24" className="h-[18px] w-[18px] transition-colors"
          fill={fav ? "rgb(var(--app-danger))" : "none"} stroke={fav ? "rgb(var(--app-danger))" : "#9aa1ab"}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 14c1.5-1.5 2.5-3 2.5-5A5.5 5.5 0 0 0 12 5.6 5.5 5.5 0 0 0 2.5 9c0 2 1 3.5 2.5 5l7 7z" />
        </svg>
      </span>
    </button>
  );
}

/** Название для показа: без кода страны и с брендом впереди, если его в
 *  названии нет. `title_clean` приходит с backend; старый ответ без него
 *  (кэш прошлого визита, фикстура AI) читается по `title`, как раньше. */
export function productName(card: Pick<TCard, "title" | "title_clean" | "brand">): string {
  const name = card.title_clean || card.title;
  return card.brand && !name.toLowerCase().includes(card.brand.toLowerCase())
    ? `${card.brand} ${name}`
    : name;
}

export function Badge({ color, children }: {
  color: "red" | "blue" | "green" | "orange" | "gold" | "gray"; children: ReactNode;
}) {
  const map = {
    red: "bg-danger text-white",
    blue: "bg-accent text-white",
    green: "bg-green text-white",
    orange: "bg-orange text-white",
    // Золото читается только на тёмном: жёлтый текст на жёлтом фоне не набирает
    // контраст. Отсюда тёмно-коричневая подложка, а не золотая заливка.
    gold: "bg-[#2b1c00] text-[#ffce6a]",
    // «Б/у» — нейтральная информация о товаре, не промо-сигнал вроде «Хит»/
    // скидки/легендарного: подложка нарочно спокойная, не соревнуется с ними.
    gray: "bg-mutedbg text-muted",
  };
  // inline-flex + gap: у бейджа может быть иконка перед подписью («Хит»), и она
  // обязана стоять на общей вертикальной оси с текстом, а не «висеть» рядом.
  // px-1.5 и font-medium вместо px-2/font-semibold: бейдж лежит поверх
  // фотографии товара, и каждый лишний пиксель его подложки отнят у того, ради
  // чего плитка существует. Читаемость держит контраст заливки, а не жир шрифта.
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-4 ${map[color]}`}>{children}</span>
  );
}

/** Кнопка корзины на карточке: «+» до добавления, степпер после.
 *
 *  Занимает строку фиксированной высоты, поэтому все карточки в сетке остаются
 *  одной высоты и ничего не «прыгает» в момент добавления.
 *
 *  Товар, который заказать нельзя (нет в наличии, снят с публикации), кнопку не
 *  получает: показывать «+», который не сработает, — обещание, которого нет.
 *  Вместо неё — переход на карточку, где живёт «Узнать о поступлении». */
function CardCartControl({ card, onOpen }: { card: TCard; onOpen: () => void }) {
  const { item, busy } = useCartEntry(card.id);
  const addButtonRef = useCartSwapOut<HTMLButtonElement>(!!item);
  // Режим приходит с backend. Старый ответ без него (кэш/AI-фикстура) —
  // ориентируемся на in_stock, как делала витрина до корзины.
  const orderable = card.availability_mode ? canAddToCart(card.availability_mode) : card.in_stock !== false;

  async function add(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    haptic("light");
    track("cart_add", { product_id: card.id, source: "card" });
    try {
      await addToCart({
        id: card.id, title: card.title, price: card.price, image: card.image,
        sku: card.sku, brand: card.brand, category: card.category,
        max_quantity: card.max_quantity,
      });
      toast("Добавлено в корзину");
    } catch {
      toast("Не удалось добавить в корзину", "error");
    }
  }

  async function change(next: number) {
    if (!item) return;
    haptic("light");
    try {
      if (next <= 0) await removeCartItem(item.id);
      else await setItemQuantity(item.id, next);
    } catch {
      toast("Не удалось обновить корзину", "error");
    }
  }

  if (!orderable) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        className="tap h-11 w-full rounded-field bg-mutedbg text-[12px] font-semibold text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Узнать о поступлении
      </button>
    );
  }

  // Кнопка и степпер лежат друг на друге и меняются встречным движением
  // (.cart-morph в index.css). Кнопка остаётся в DOM и после добавления —
  // уходить нечему, если размонтировать её тем же кадром, каким появился
  // степпер; вместо этого она гаснет и уменьшается, а степпер раскрывается ей
  // навстречу. Скрытый слой недоступен ни пальцу (pointer-events), ни
  // скринридеру, ни табу: невидимая кнопка «Добавить» поверх «−» добавляла бы
  // товар вместо уменьшения.
  const added = !!item;

  return (
    <div className="cart-morph h-11">
    {item && (
      <div ref={enterRefCallback("slide", 0, CART_SWAP_DX_PX)} className="cart-morph-layer">
        <QuantityStepper
          quantity={item.quantity}
          max={item.max_quantity}
          busy={busy}
          size="sm"
          onChange={change}
          ariaLabel={`Количество: ${card.title}`}
        />
      </div>
    )}
    <button
      ref={addButtonRef}
      onClick={add}
      data-hidden={added}
      aria-hidden={added}
      tabIndex={added ? -1 : undefined}
      aria-label={`Добавить в корзину: ${card.title}`}
      // Легендарный товар отличается ЦВЕТОМ ДЕЙСТВИЯ, а не рамкой вокруг
      // карточки. Текст тёмный, а не белый: белое на этом золоте даёт 2,8:1
      // при норме 4,5:1, тёмное — 6,9:1. Золото приглушённое (#C8921F), то же,
      // что было в рамке: менять фирменный тон вместе с носителем незачем.
      // Высота 44px неприкосновенна — это минимальная цель касания. Вес снят
      // тем, что снимается без неё: радиус ушёл на общую шкалу (12px вместо 14px,
      // tailwind.config), начертание — с semibold на medium. Заливка осталась
      // синей: это единственное действие плитки, и превращать его в обводку
      // значит прятать то, ради чего на витрину пришли.
      className={`tap cart-morph-layer flex h-11 w-full items-center justify-center gap-1.5 rounded-field text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        card.is_legendary
          ? "bg-[#C8921F] text-[#241800] hover:bg-[#b3811a]"
          : "bg-accent text-white hover:bg-accentdark"
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
        strokeWidth="2.4" strokeLinecap="round">
        <path d="M12 6v12M6 12h12" />
      </svg>
      Добавить
    </button>
    </div>
  );
}

/** Карточка товара. Цена и наличие — из данных карточки (из БД), не пересчитываются. */
function ProductCard({ card, compact, onOpen }: Props) {
  const navigate = useNavigate();
  const disc = discountPct(card.price, card.old_price);
  const badges = cardBadges(card, disc);
  const open = useCallback(() => {
    onOpen?.(card);
    navigate(`/product/${card.id}`);
  }, [card, navigate, onOpen]);

  // Эффективная галерея карточки: images (из resolver групп), иначе одиночное
  // image, иначе пусто. Лимит 10 (backend уже режет; здесь — защита).
  const gallery = useMemo(
    () => (card.images && card.images.length ? card.images : card.image ? [card.image] : [])
      .filter(Boolean)
      .slice(0, MAX_CARD_IMAGES),
    [card.image, card.images],
  );

  return (
    // h-full + flex-col: в сетке все карточки одной высоты, кнопка прижата вниз.
    // lg:hover — desktop-состояние; tap scale остаётся на mobile.
    <div
      ref={enterGridRefCallback("fadeUp")}
      // Волосяная рамка вместо тени (v5.6.0). Плитка лежит в потоке сетки и
      // никуда не всплывает — тень давала ей высоту, которой у неё нет, а два
      // десятка теней на экране складывались в серую рябь между карточками.
      // Отделяют плитку от фона контраст поверхности и пространство; тень
      // остаётся там, где высота настоящая, — на наведении и у панелей.
      className={`product-card-viewport lift flex h-full flex-col overflow-hidden rounded-xl2 border border-border bg-surface lg:hover:shadow-float ${
        compact ? "w-40 shrink-0 lg:w-auto" : ""
      }`}
    >
      {/* Легендарная карточка не отличается ни рамкой, ни бликом.

          Рамка (box-shadow на 1.5px наружу) срезалась верхней кромкой любой
          ленты прокрутки — чинилось в трёх местах разом. Блик ездил кадрами из
          JS и ронял прокрутку на телефоне: каждый кадр двигал полупрозрачный
          градиент во всю высоту карточки под overflow-hidden со скруглением,
          то есть заставлял композитор перерисовывать её целиком. Витрина —
          мобильная, и плавность ленты стоит дороже украшения на одном товаре.

          Опознание несёт бейдж «Легендарный», отличие — цвет кнопки: он не
          трогает картинку, ничего не анимирует и подсвечивает то, ради чего
          карточка существует. */}
      {/* Карусель + бейджи + избранное — соседи в relative-контейнере (валидный DOM,
          вложенных кнопок нет). aspect-square: высота image-области стабильна. */}
      <div className="relative">
        <CardCarousel
          id={card.id} images={gallery} title={card.title} category={card.category}
          compact={compact} onOpen={open} bleed={card.is_legendary}
        />
        <div className="pointer-events-none absolute left-2 top-2 z-20 flex flex-col items-start gap-1 [will-change:transform]">
          {/* Не более двух бейджей и в фиксированном порядке важности — правило
              живёт в lib/cardBadges с тестами. Раньше рисовались все подходящие
              сразу, и стопка из четырёх заливок ложилась поверх фотографии,
              ничего при этом не выделяя: когда выделено всё, не выделено ничто.

              «Хит» на легендарном товаре гасит backend (to_card): правило одно
              на все места, где рисуется карточка, а не продублировано в вёрстке. */}
          {badges.map((kind) => {
            if (kind === "legendary") return <Badge key={kind} color="gold">Легендарный</Badge>;
            if (kind === "discount") return <Badge key={kind} color="red">−{disc}%</Badge>;
            if (kind === "hot") {
              return (
                <Badge key={kind} color="orange">
                  <Icon name="flame" className="h-3 w-3" strokeWidth={2.2} />Хит
                </Badge>
              );
            }
            return <Badge key={kind} color="gray">Б/у</Badge>;
          })}
        </div>
        {/* Бейджа «Сегодня» здесь нет намеренно. Он отмечал исключение, пока
            забрать в день обращения можно было единичные позиции. Сейчас флаг
            стоит у всех товаров в наличии, и бейдж оказывался на каждой плитке
            — поверх фото, рядом с «Хит» и скидкой, ничего не различая. Срок
            получения остался на карточке товара (плитка «В наличии · Забрать
            сегодня» и раздел «Доставка и получение»), где он отвечает на
            вопрос, который человек к тому моменту действительно задал. */}
        {/* right-0.5/top-0.5, а не right-2/top-2: обёртка стала 44px, кружок
            внутри неё смещён на 6px — итоговый отступ кружка тот же 8px. */}
        <FavButton id={card.id} className="absolute right-0.5 top-0.5 z-20 [will-change:transform]" />
      </div>

      <div className="flex flex-1 flex-col p-3">
        {/* Порядок «название -> цена», а не наоборот (v5.6.0). Цена, стоящая
            первой, заставляет читать плитку задом наперёд: сначала сумма, потом
            выяснение, за что она. Сначала предмет, затем его цена — и цена
            остаётся самым тяжёлым элементом блока за счёт размера и насыщенности,
            а не за счёт места в очереди. */}
        <button onClick={open} onPointerDown={() => preloadRoute("/product")} className="block w-full text-left">
          {/* Название на карточке — чистое, без приставки региона: товары
              должны начинаться с модели («iPhone 17 Pro…»), а не с флага
              перед ней. title_clean уже вырезает «(HK-KR, SIM+eSIM)» из
              текста; сам регион — на странице товара, во вкладке «Описание». */}
          <p className="line-clamp-2 min-h-[2.25rem] text-footnote font-medium">
            {productName(card)}
          </p>
        </button>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-title font-bold tracking-tight">{formatPrice(card.price)}</span>
          {/* old_price показываем только когда реально даёт скидку — иначе цифры вводят в заблуждение */}
          {disc !== null && (
            <span className="text-[11px] text-muted line-through">{formatPrice(card.old_price!)}</span>
          )}
        </div>
        {/* Подпись наличия читает РЕЖИМ, а не голый in_stock: у предзаказа
            in_stock=true, и карточка писала «В наличии», хотя в корзине тот же
            товар честно помечен предзаказом. Две разные правды об одном товаре
            на соседних экранах — хуже, чем одна скучная. */}
        {/* 12px, а не 11: наличие — обещание магазина, и набирать его ниже
            читаемого минимума значит прятать самое проверяемое утверждение
            карточки. То же у остатка и социального доказательства ниже. */}
        <p className={`mt-1 text-[12px] font-medium ${availabilityTone(card)}`}>
          {availabilityText(card)}
        </p>
        {/* Остаток — только у лимитированных товаров (флаг из админки), а не у
            всего, где склад меньше пяти штук: иначе срочность ложная. */}
        {card.is_limited && card.in_stock && card.stock != null && card.stock > 0 && (
          <p className="mt-0.5 text-[12px] font-medium text-orange">Осталось {card.stock} шт</p>
        )}
        {/* Социальное доказательство: строка приходит с backend посчитанной.
            В плитке она обрезается одной строкой — карточки в сетке обязаны
            остаться одной высоты, иначе ряд «поедет». */}
        {card.social_proof && (
          <p className="mt-0.5 truncate text-[12px] text-muted">{card.social_proof}</p>
        )}
        {/* Спейсер прижимает действие к низу карточки при разной высоте контента */}
        <span aria-hidden className="flex-1" />
        {/* Фиксированная высота строки действия (h-9 внутри) — при добавлении
            «+» меняется на степпер, и карточка не должна от этого расти. */}
        <div className="mt-2.5">
          <CardCartControl card={card} onOpen={open} />
        </div>
      </div>
    </div>
  );
}

export default memo(ProductCard);
