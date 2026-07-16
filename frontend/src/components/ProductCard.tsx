import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ProductCard as TCard } from "./ai/types";
import { formatPrice, discountPct } from "../lib/format";
import { useFavorite } from "../lib/favorites";

type Props = {
  card: TCard;
  onLead?: (card: TCard) => void;
  compact?: boolean;
};

/** Пастельный градиент + эмодзи по категории — вместо «дешёвого» серого блока. */
const PLACEHOLDER_STYLE: Record<string, { emoji: string; from: string; to: string }> = {
  "смартфоны": { emoji: "📱", from: "#e3f2fd", to: "#cfe6fb" },
  "ноутбуки": { emoji: "💻", from: "#ede9fe", to: "#ddd4fa" },
  "планшеты": { emoji: "📲", from: "#e0f2fe", to: "#cdeafd" },
  "наушники": { emoji: "🎧", from: "#ffe9ec", to: "#ffd9df" },
  "консоли": { emoji: "🎮", from: "#e8f5e9", to: "#d5edd8" },
  "dyson": { emoji: "💨", from: "#fff3d6", to: "#ffe9b8" },
  "аксессуары": { emoji: "🔌", from: "#f1f3f5", to: "#e4e8ec" },
};
const PLACEHOLDER_DEFAULT = { emoji: "📦", from: "#eef2f7", to: "#dfe7f0" };

/** Градиентная заглушка вместо битой/отсутствующей картинки — UI не прыгает. */
export function ProductImage({
  src, title, category, className = "",
}: { src?: string; title: string; category?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  const showImg = src && !failed;
  const ph = PLACEHOLDER_STYLE[(category ?? "").toLowerCase()] ?? PLACEHOLDER_DEFAULT;
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ background: `linear-gradient(135deg, ${ph.from}, ${ph.to})` }}
    >
      {showImg ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center">
          <span className="text-3xl drop-shadow-sm">{ph.emoji}</span>
          <span className="line-clamp-1 rounded-full bg-white/70 px-2.5 py-0.5 text-[10px] font-semibold text-[#5b6472]">
            {title}
          </span>
        </div>
      )}
    </div>
  );
}

/** Сердечко «в избранное» (localStorage, демо). */
export function FavButton({ id, className = "" }: { id: number; className?: string }) {
  const [fav, toggle] = useFavorite(id);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); toggle(); }}
      aria-label={fav ? "Убрать из избранного" : "В избранное"}
      className={`tap flex h-8 w-8 items-center justify-center rounded-full bg-white/90 shadow-soft ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"
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
export default function ProductCard({ card, onLead, compact }: Props) {
  const navigate = useNavigate();
  const disc = discountPct(card.price, card.old_price);

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
        <button onClick={() => navigate(`/product/${card.id}`)} className="block w-full text-left">
          {/* h-40 (160px) вместо aspect-square: карточка компактнее, сетка плотнее */}
          <ProductImage src={card.image} title={card.title} category={card.category} className="h-40 w-full" />
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
          {card.old_price && (
            <span className="text-[11px] text-muted line-through">{formatPrice(card.old_price)}</span>
          )}
        </div>
        <button onClick={() => navigate(`/product/${card.id}`)} className="block w-full text-left">
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
