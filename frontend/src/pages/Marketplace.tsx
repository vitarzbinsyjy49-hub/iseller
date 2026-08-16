/** Экран «Маркетплейс» (/marketplace) — витрина одобренных пользовательских
 *  товаров (заявки sell_item, опубликованные из админки — Task 14). Плоский
 *  список без категорий/брендов: это осознанный MVP-объём дизайна, фильтры
 *  сюда не добавляем.
 *
 *  CTA сверху ведёт на визард подачи заявки (/sell, Task 19) — человек мог
 *  зайти сюда посмотреть чужие товары и захотеть предложить свой.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import ProductCard from "../components/ProductCard";
import { ProductCard as TCard } from "../components/ai/types";
import { ErrorState, EmptyState } from "../components/StateViews";

export default function Marketplace() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setCards(null);
    setError(false);
    api<{ cards?: TCard[] }>("/catalog/marketplace")
      .then((d) => setCards(Array.isArray(d.cards) ? d.cards : []))
      .catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-md p-4 pb-28">
      <h1 className="text-xl font-bold">Маркетплейс</h1>
      <p className="mt-1 text-sm text-muted">Б/у техника от пользователей, проверенная магазином.</p>

      <button
        type="button"
        onClick={() => navigate("/sell")}
        className="tap mt-4 flex w-full items-center gap-3 rounded-xl2 bg-surface p-4 text-left shadow-card"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
          +
        </span>
        <span>
          <span className="block text-sm font-bold">Есть что продать?</span>
          <span className="block text-xs text-muted">Предложить товар</span>
        </span>
      </button>

      {error ? (
        <div className="mt-6"><ErrorState message="Не удалось загрузить маркетплейс" onRetry={load} /></div>
      ) : cards === null ? (
        <div className="mt-6 grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton aspect-[3/4] rounded-xl2" />)}
        </div>
      ) : cards.length === 0 ? (
        <EmptyState message="Пока здесь пусто — станьте первым, кто предложит товар." />
      ) : (
        <div className="stagger mt-6 grid grid-cols-2 gap-3">
          {cards.map((c) => <ProductCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}
