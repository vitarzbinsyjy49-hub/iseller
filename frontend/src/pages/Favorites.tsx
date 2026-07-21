import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";
import { ErrorState } from "../components/StateViews";
import { useFavoriteIds } from "../lib/favorites";

/** Экран «Избранное»: карточки серверного избранного. Удаление сердечком —
 *  карточка исчезает сразу (фильтр по актуальным id), без перезагрузки. */
export default function Favorites() {
  const navigate = useNavigate();
  const favIds = useFavoriteIds();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [error, setError] = useState(false);
  const [lead, setLead] = useState<TCard | null>(null);

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
        <EmptyFavorites onCatalog={() => navigate("/catalog")} />
      ) : (
        <div className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {visible.map((c) => <ProductCard key={c.id} card={c} onLead={setLead} />)}
        </div>
      )}

      {lead && (
        <LeadForm
          productId={lead.id} productTitle={lead.title} productPrice={lead.price}
          source="favorites" onClose={() => setLead(null)}
        />
      )}
    </div>
  );
}

function EmptyFavorites({ onCatalog }: { onCatalog: () => void }) {
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
      <button
        onClick={onCatalog}
        className="tap mt-5 rounded-xl2 bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accentdark"
      >
        Перейти в каталог
      </button>
    </div>
  );
}
