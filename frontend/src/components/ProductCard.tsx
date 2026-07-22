import { useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ProductCard as TCard } from "./ai/types";
import { formatPrice, discountPct } from "../lib/format";
import { imagePaddingClass } from "../lib/viewport";
import { useFavorite } from "../lib/favorites";
import { haptic } from "../lib/telegram";
import { toast } from "../lib/toast";

type Props = {
  card: TCard;
  onLead?: (card: TCard) => void;
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
      case "dyson":
        return <><path d="M4 9h8.5A2.75 2.75 0 1 0 9.75 6" /><path d="M4 13h11a2.75 2.75 0 1 1-2.75 3" /></>;
      case "аксессуары":
        return <><path d="M9.5 3v4.5M14.5 3v4.5" /><rect x="7.5" y="7.5" width="9" height="6" rx="2" /><path d="M12 13.5V18a3 3 0 0 1-3 3" /></>;
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
 *  - compact (узкая карточка в ленте): подпись «Фото скоро появится» скрываем. */
export function ProductImage({
  src, title, category, className = "", compact = false,
}: { src?: string; title: string; category?: string | null; className?: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [pad, setPad] = useState<"p-2" | "p-1">("p-2");
  const showImg = src && !failed;
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={
        showImg
          ? { background: "var(--app-surface)" }
          : { background: "linear-gradient(160deg,#f5f6f8,#e8eaee)" }
      }
    >
      {showImg ? (
        <img
          src={src}
          alt={title}
          loading="lazy"
          decoding="async"
          className={`h-full w-full object-contain object-center ${pad}`}
          onError={() => setFailed(true)}
          onLoad={(e) => {
            const img = e.currentTarget;
            setPad(imagePaddingClass(img.naturalWidth, img.naturalHeight));
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

/** Сердечко «в избранное»: серверное хранение, оптимистичный тоггл с откатом,
 *  тактильный отклик, toast и короткая scale-анимация. stopPropagation —
 *  тап по сердцу не открывает карточку товара. */
export function FavButton({ id, className = "" }: { id: number; className?: string }) {
  const [fav, toggle, busy] = useFavorite(id);
  const [pop, setPop] = useState(false);

  async function onClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;             // антидабл-клик
    haptic("light");
    setPop(true);
    window.setTimeout(() => setPop(false), 220);
    try {
      const nowFav = await toggle();
      toast(nowFav ? "Добавлено в избранное" : "Удалено из избранного");
    } catch {
      toast("Не удалось обновить избранное", "error");
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={fav}
      aria-label={fav ? "Убрать из избранного" : "В избранное"}
      className={`tap flex h-8 w-8 items-center justify-center rounded-full bg-white/90 shadow-soft transition-transform duration-200 ${pop ? "scale-125" : ""} ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] transition-colors"
        fill={fav ? "#ff3b30" : "none"} stroke={fav ? "#ff3b30" : "#9aa1ab"}
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 14c1.5-1.5 2.5-3 2.5-5A5.5 5.5 0 0 0 12 5.6 5.5 5.5 0 0 0 2.5 9c0 2 1 3.5 2.5 5l7 7z" />
      </svg>
    </button>
  );
}

export function Badge({ color, children }: { color: "red" | "blue" | "green" | "orange"; children: ReactNode }) {
  const map = {
    red: "bg-[#ff3b30] text-white",
    blue: "bg-accent text-white",
    green: "bg-green text-white",
    orange: "bg-orange text-white",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4 ${map[color]}`}>{children}</span>
  );
}

/** Карточка товара. Цена и наличие — из данных карточки (из БД), не пересчитываются. */
export default function ProductCard({ card, onLead, compact, onOpen }: Props) {
  const navigate = useNavigate();
  const disc = discountPct(card.price, card.old_price);
  const open = () => { onOpen?.(card); navigate(`/product/${card.id}`); };

  return (
    // h-full + flex-col: в сетке все карточки одной высоты, кнопка прижата вниз.
    // lg:hover — desktop-состояние; tap scale остаётся на mobile.
    <div
      className={`card-appear tap flex h-full flex-col overflow-hidden rounded-xl2 bg-surface shadow-soft transition-shadow lg:hover:shadow-[0_10px_28px_rgba(17,24,39,0.12)] ${
        compact ? "w-40 shrink-0 lg:w-auto" : ""
      }`}
    >
      {/* FavButton — сосед кнопки, не вложен в неё (валидный DOM) */}
      <div className="relative">
        <button onClick={open} className="block w-full text-left">
          {/* aspect-square: одинаковая высота image-area у всех карточек ряда,
              высота не меняется после загрузки фото (нет layout shift) */}
          <ProductImage src={card.image} title={card.title} category={card.category} className="aspect-square w-full" compact={compact} />
          <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
            {card.is_hot && <Badge color="orange">🔥 Хит</Badge>}
            {disc && <Badge color="red">−{disc}%</Badge>}
          </div>
          {card.is_available_today && card.in_stock && (
            <span className="absolute bottom-2 left-2">
              <Badge color="green">Сегодня</Badge>
            </span>
          )}
        </button>
        <FavButton id={card.id} className="absolute right-2 top-2" />
      </div>

      <div className="flex flex-1 flex-col p-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[16px] font-bold leading-5">{formatPrice(card.price)}</span>
          {/* old_price показываем только когда реально даёт скидку — иначе цифры вводят в заблуждение */}
          {disc !== null && (
            <span className="text-[11px] text-muted line-through">{formatPrice(card.old_price!)}</span>
          )}
        </div>
        <button onClick={open} className="block w-full text-left">
          <p className="mt-0.5 line-clamp-2 min-h-[2.4rem] text-[13px] font-medium leading-5">
            {card.brand && !card.title.toLowerCase().includes(card.brand.toLowerCase())
              ? `${card.brand} ${card.title}`
              : card.title}
          </p>
        </button>
        <p className={`mt-0.5 text-[11px] font-medium ${card.in_stock ? "text-green" : "text-muted"}`}>
          {card.in_stock ? (card.is_available_today ? "В наличии · Сегодня" : "В наличии") : "Под заказ"}
        </p>
        {card.in_stock && card.stock != null && card.stock > 0 && card.stock <= 5 && (
          <p className="mt-0.5 text-[11px] font-medium text-orange">Осталось {card.stock} шт</p>
        )}
        {/* Спейсер прижимает кнопку к низу карточки при разной высоте контента */}
        <span aria-hidden className="flex-1" />
        <button
          onClick={() => onLead?.(card)}
          className="tap mt-2 w-full rounded-xl bg-mutedbg py-2 text-xs font-semibold text-text transition-colors hover:bg-accent hover:text-white"
        >
          Заявка
        </button>
      </div>
    </div>
  );
}
