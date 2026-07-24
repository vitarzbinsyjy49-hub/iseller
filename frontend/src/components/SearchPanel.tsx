import { useEffect, useState } from "react";
import { track } from "../lib/analytics";
import { ProductCard as TCard } from "./ai/types";
import { ProductImage } from "./ProductCard";
import { formatPrice } from "../lib/format";
import { useLiveSearch, MIN_QUERY_LEN } from "../lib/liveSearch";
import { clearSearchHistory, loadSearchHistory } from "../lib/searchHistory";

/** Сценарные чипы поиска: только маршруты, которые каталог реально понимает
 *  (query/category/today) — никаких выдуманных фильтров. Консультационные
 *  сценарии (Trade-In, бизнес) живут в блоке сценариев на главной, здесь —
 *  быстрые товарные намерения. */
const SCENARIO_CHIPS: { label: string; route: string }[] = [
  { label: "iPhone", route: "/catalog?query=iPhone" },
  { label: "MacBook", route: "/catalog?query=MacBook" },
  { label: "AirPods", route: "/catalog?query=AirPods" },
  { label: "Забрать сегодня", route: "/catalog?today=1" },
  { label: "Аксессуары", route: `/catalog?category=${encodeURIComponent("аксессуары")}` },
];

type Props = {
  /** Текущий текст в поисковом инпуте (владелец инпута — родитель). */
  query: string;
  /** Навигация с закрытием панели (родитель делает navigate + close). */
  onNavigate: (to: string) => void;
  /** Подставить текст из истории в инпут (без немедленной навигации). */
  onPickQuery: (q: string) => void;
  /** Быстрые категории (родитель уже знает их — heroChips на главной). */
  chips?: { key: string; label: string; route: string }[];
  /** «Недавно смотрели» — данные уже загружены родителем, второй запрос не нужен. */
  recentlyViewed?: TCard[] | null;
  /** Показывать ли live-результаты (на desktop-шапке результаты рисует каталог). */
  withResults?: boolean;
};

/** Содержимое умной поисковой панели. Родитель решает, КОГДА и ГДЕ её показать
 *  (dropdown под hero на mobile, компактный popover в шапке на desktop) —
 *  панель отвечает только за наполнение:
 *  - пустой запрос: история (localStorage) + сценарные чипы + недавно
 *    просмотренные + быстрые категории + «Спросить AI»;
 *  - есть запрос: live-результаты (/catalog/search, debounce + abort) либо
 *    «ничего не нашлось» с выходами в AI и каталог.
 *  Обычный поиск — детерминированный каталог; сложные запросы уходят в AI. */
export default function SearchPanel({
  query, onNavigate, onPickQuery, chips = [], recentlyViewed, withResults = true,
}: Props) {
  const trimmed = query.trim();
  const typing = withResults && trimmed.length >= MIN_QUERY_LEN;
  const { results, searching } = useLiveSearch(withResults ? query : "");
  // Историю читаем на маунте панели и после очистки — между сессиями она в localStorage.
  const [history, setHistory] = useState<string[]>(() => loadSearchHistory());

  useEffect(() => {
    if (!typing) setHistory(loadSearchHistory());
  }, [typing]);

  function askAi() {
    track("search_ai_escalated", { query_length: trimmed.length });
    // auto=1 — одноразовая отправка: пользователь явно нажал «Спросить AI»
    // с конкретным запросом; пустой запрос — просто открываем AI-экран.
    onNavigate(trimmed ? `/ai?q=${encodeURIComponent(trimmed)}&auto=1` : "/ai");
  }

  if (typing) {
    return (
      <div role="listbox" aria-label="Результаты поиска">
        {searching && results === null ? (
          <p className="px-4 py-3.5 text-sm text-muted">Ищем…</p>
        ) : results && results.length > 0 ? (
          <>
            {results.map((c) => (
              <button
                key={c.id}
                role="option"
                aria-selected={false}
                onClick={() => {
                  track("search_result_clicked", { product_id: c.id });
                  onNavigate(`/product/${c.id}`);
                }}
                className="tap flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-0"
              >
                <ProductImage src={c.image} title={c.title} category={c.category}
                  className="h-11 w-11 shrink-0 rounded-xl" compact />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 block text-sm font-medium">{c.title}</span>
                  <span className={`text-[11px] font-medium ${c.in_stock ? "text-green" : "text-muted"}`}>
                    {c.in_stock ? "В наличии" : "Под заказ"}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-bold">{formatPrice(c.price)}</span>
              </button>
            ))}
            <button
              onClick={() => {
                track("search_query_submitted", { query_length: trimmed.length, source: "all_results" });
                onNavigate(`/catalog?query=${encodeURIComponent(trimmed)}`);
              }}
              className="tap w-full bg-mutedbg px-4 py-3 text-center text-xs font-semibold text-accent"
            >
              Все результаты в каталоге →
            </button>
          </>
        ) : (
          <div className="px-4 py-4 text-center">
            <p className="text-sm font-semibold">Ничего не нашлось</p>
            <p className="mt-1 text-[13px] text-muted">
              Попробуйте изменить формулировку — например, «iPhone 15» или «MacBook Air».
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button onClick={askAi}
                className="tap rounded-field bg-accent px-4 py-2.5 text-[13px] font-semibold text-white">
                ✨ Спросить AI «{trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed}»
              </button>
              <button onClick={() => onNavigate("/catalog")}
                className="tap rounded-field bg-mutedbg px-4 py-2.5 text-[13px] font-semibold text-text">
                Открыть каталог
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ===== Пустой запрос: полезное состояние вместо пустого дропдауна =====
  return (
    <div className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain p-3">
      {history.length > 0 && (
        <section aria-label="Недавние запросы">
          <div className="flex items-baseline justify-between px-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Вы искали</p>
            <button
              onClick={() => { clearSearchHistory(); setHistory([]); }}
              className="text-xs font-medium text-muted transition-colors hover:text-text"
            >
              Очистить
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {history.map((h) => (
              <button
                key={h}
                onClick={() => onPickQuery(h)}
                className="tap max-w-full truncate rounded-full bg-mutedbg px-3 py-1.5 text-[13px] font-medium text-text"
              >
                {h}
              </button>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Популярные запросы" className={history.length > 0 ? "mt-3.5" : ""}>
        <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Часто ищут</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SCENARIO_CHIPS.map((s) => (
            <button
              key={s.label}
              onClick={() => onNavigate(s.route)}
              className="tap rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-text"
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      {recentlyViewed && recentlyViewed.length >= 2 && (
        <section aria-label="Недавно смотрели" className="mt-3.5">
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Недавно смотрели</p>
          <div className="no-scrollbar -mx-3 mt-2 flex gap-2 overflow-x-auto px-3">
            {recentlyViewed.slice(0, 8).map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  track("search_result_clicked", { product_id: c.id, source: "recently_viewed" });
                  onNavigate(`/product/${c.id}`);
                }}
                className="tap w-24 shrink-0 text-left"
              >
                <ProductImage src={c.image} title={c.title} category={c.category}
                  className="aspect-square w-full rounded-xl" compact />
                <span className="mt-1 line-clamp-2 block text-[11px] font-medium leading-[1.3]">{c.title}</span>
                <span className="block text-[11px] font-bold">{formatPrice(c.price)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {chips.length > 0 && (
        <section aria-label="Категории" className="mt-3.5">
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Категории</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.key}
                onClick={() => onNavigate(c.route)}
                className="tap rounded-full bg-mutedbg px-3 py-1.5 text-[13px] font-medium text-text"
              >
                {c.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <button
        onClick={askAi}
        className="tap mt-3.5 flex w-full items-center gap-3 rounded-field bg-accent/10 px-3.5 py-3 text-left"
      >
        <span aria-hidden className="text-lg">✨</span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-accent">Спросить AI</span>
          <span className="block text-[11px] text-muted">Опишите задачу — подберём из реального наличия</span>
        </span>
      </button>
    </div>
  );
}
