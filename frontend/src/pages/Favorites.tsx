import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard, { ProductImage } from "../components/ProductCard";
import { ErrorState } from "../components/StateViews";
import { useFavoriteIds } from "../lib/favorites";
import { track } from "../lib/analytics";
import { Icon } from "../components/icons";

/** Экран «Избранное»: карточки серверного избранного. Удаление сердечком —
 *  карточка исчезает сразу (фильтр по актуальным id), без перезагрузки. */
export default function Favorites() {
  const navigate = useNavigate();
  const favIds = useFavoriteIds();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setCards(null);
    setError(false);
    api<{ cards: TCard[] }>("/favorites")
      .then((d) => setCards(Array.isArray(d.cards) ? d.cards : []))
      .catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Показываем только то, что ещё в избранном: снятое сердечком уходит сразу.
  const visible = cards?.filter((c) => favIds.includes(c.id)) ?? null;

  return (
    <div className="mx-auto max-w-md lg:max-w-none">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Избранное</h1>
        {visible && visible.length > 0 && (
          <span className="text-sm text-muted">{visible.length}</span>
        )}
      </div>

      {error ? (
        <div className="mt-6"><ErrorState message="Не удалось загрузить избранное" onRetry={load} /></div>
      ) : visible === null ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton aspect-[3/4] rounded-xl2" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyFavorites
          onCatalog={() => {
            track("empty_state_action_clicked", { source: "favorites_catalog" });
            navigate("/catalog");
          }}
          onAi={() => {
            track("empty_state_action_clicked", { source: "favorites_ai" });
            navigate("/ai");
          }}
          onProduct={(id) => navigate(`/product/${id}`)}
        />
      ) : (
        <div className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {visible.map((c) => <ProductCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}

/** Пустое избранное — не тупик: каталог, AI-подбор и «недавно смотрели»
 *  (существующий endpoint; грузится только когда пустое состояние показано). */
function EmptyFavorites({
  onCatalog, onAi, onProduct,
}: { onCatalog: () => void; onAi: () => void; onProduct: (id: number) => void }) {
  const [recent, setRecent] = useState<TCard[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    api<{ cards?: TCard[] }>("/catalog/recently-viewed?limit=8", { signal: controller.signal })
      .then((d) => setRecent(Array.isArray(d.cards) ? d.cards : []))
      .catch(() => { /* блок просто не показывается */ });
    return () => controller.abort();
  }, []);

  return (
    <div className="fade-in mt-10 flex flex-col items-center px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-mutedbg">
        <svg viewBox="0 0 24 24" className="h-8 w-8 text-[#b6bcc5]" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 14c1.5-1.5 2.5-3 2.5-5A5.5 5.5 0 0 0 12 5.6 5.5 5.5 0 0 0 2.5 9c0 2 1 3.5 2.5 5l7 7z" />
        </svg>
      </div>
      <p className="mt-4 text-[17px] font-bold">Пока здесь пусто</p>
      <p className="mt-1.5 max-w-xs text-sm text-muted">
        Добавляйте понравившиеся товары, чтобы быстро вернуться к ним позже.
      </p>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <button
          onClick={onCatalog}
          className="tap rounded-xl2 bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accentdark"
        >
          Перейти в каталог
        </button>
        <button
          onClick={onAi}
          className="tap flex items-center justify-center gap-2 rounded-xl2 bg-surface px-5 py-2.5 text-sm font-semibold text-accent shadow-soft"
        >
          <Icon name="sparkles" className="h-4 w-4" strokeWidth={2} />
          Подобрать через AI
        </button>
      </div>

      {recent.length >= 2 && (
        <div className="mt-8 w-full max-w-md text-left">
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Вы недавно смотрели</p>
          <div className="no-scrollbar -mx-6 mt-2 flex gap-2 overflow-x-auto px-6">
            {recent.map((c) => (
              <button key={c.id} onClick={() => onProduct(c.id)} className="tap w-24 shrink-0 text-left">
                <ProductImage src={c.image} title={c.title} category={c.category}
                  className="aspect-square w-full rounded-xl" compact />
                <span className="mt-1 line-clamp-2 block text-[11px] font-medium leading-[1.3]">{c.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
