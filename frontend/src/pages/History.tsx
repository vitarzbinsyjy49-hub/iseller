import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import { ErrorState } from "../components/StateViews";
import { Icon } from "../components/icons";
import { enterRefCallback } from "../lib/useEnter";
import ScreenHeader from "../components/ScreenHeader";
import { useCollapsingHeader } from "../lib/useCollapsingHeader";

/** История просмотров (/history): существующий /catalog/recently-viewed,
 *  никакой новой таблицы. Карточки с избранным и переходом в ProductDetails.
 *  Пункт «История просмотров» в профиле раньше был заглушкой «Скоро». */
export default function History() {
  const navigate = useNavigate();
  const collapsing = useCollapsingHeader();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setCards(null);
    setError(false);
    // limit=20 — максимум, который допускает существующий endpoint (ge=1, le=20)
    api<{ cards?: TCard[] }>("/catalog/recently-viewed?limit=20")
      .then((d) => setCards(Array.isArray(d.cards) ? d.cards : []))
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    track("history_opened");
    load();
  }, [load]);

  return (
    <div ref={collapsing} className="mx-auto max-w-md lg:max-w-none">
      <ScreenHeader
        title="История просмотров"
        actions={cards && cards.length > 0 ? <span className="text-sm text-muted">{cards.length}</span> : undefined}
      />

      {error ? (
        <div className="mt-6"><ErrorState message="Не удалось загрузить историю" onRetry={load} /></div>
      ) : cards === null ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton aspect-[3/4] rounded-xl2" />)}
        </div>
      ) : cards.length === 0 ? (
        <div ref={enterRefCallback("fade")} className="mt-14 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mutedbg text-muted">
            <Icon name="clock" className="h-7 w-7" strokeWidth={1.6} />
          </div>
          <p className="mt-3 text-[15px] font-bold">Вы пока ничего не смотрели</p>
          <p className="mx-auto mt-1 max-w-[280px] text-sm text-muted">
            Открывайте карточки товаров — они появятся здесь, чтобы к ним было легко вернуться.
          </p>
          <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
            <button
              onClick={() => {
                track("empty_state_action_clicked", { source: "history_catalog" });
                navigate("/catalog");
              }}
              className="tap rounded-xl2 bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accentdark"
            >
              Открыть каталог
            </button>
            <button
              onClick={() => {
                track("empty_state_action_clicked", { source: "history_ai" });
                navigate("/ai");
              }}
              className="tap flex items-center justify-center gap-2 rounded-xl2 bg-surface px-5 py-2.5 text-sm font-semibold text-accent shadow-soft"
            >
              <Icon name="sparkles" className="h-4 w-4" strokeWidth={2} />
              Подобрать через AI
            </button>
          </div>
        </div>
      ) : (
        <div className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {cards.map((c) => <ProductCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}
