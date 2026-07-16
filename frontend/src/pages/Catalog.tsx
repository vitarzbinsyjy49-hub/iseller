import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";

const CATS = [
  { key: "", label: "Все" },
  { key: "смартфоны", label: "Смартфоны" },
  { key: "ноутбуки", label: "Ноутбуки" },
  { key: "планшеты", label: "Планшеты" },
  { key: "наушники", label: "Наушники" },
  { key: "консоли", label: "Консоли" },
  { key: "dyson", label: "Dyson" },
  { key: "аксессуары", label: "Аксессуары" },
  { key: "__sale__", label: "Скидки" },
];
const SORTS = [
  { key: "popularity", label: "Популярные" },
  { key: "price_asc", label: "Дешевле" },
  { key: "price_desc", label: "Дороже" },
];

export default function Catalog() {
  const [params, setParams] = useSearchParams();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [category, setCategory] = useState(params.get("category") ?? "");
  const [query, setQuery] = useState(params.get("query") ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [sort, setSort] = useState("popularity");
  const [priceMax, setPriceMax] = useState("");
  const [brand, setBrand] = useState("");
  const [brands, setBrands] = useState<string[]>([]);
  const [onlyStock, setOnlyStock] = useState(false);
  const [onlyToday, setOnlyToday] = useState(params.get("today") === "1");
  const [condition, setCondition] = useState("");
  // Desktop: сворачиваемый sidebar фильтров (>=1024px)
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const collection = params.get("collection") ?? "";
  const [lead, setLead] = useState<TCard | null>(null);

  useEffect(() => { track("catalog_opened", { category }); }, []);
  useEffect(() => {
    api<{ brands: string[] }>("/catalog/brands").then((d) => setBrands(d.brands)).catch(() => {});
  }, []);

  // Live-поиск: debounce 250ms, чтобы не слать запрос на каждый символ
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setCards(null);
    const qs = new URLSearchParams();
    if (category) qs.set("category", category);
    if (debouncedQuery.trim()) qs.set("query", debouncedQuery.trim());
    if (priceMax) qs.set("price_max", priceMax);
    if (brand) qs.set("brand", brand);
    if (onlyStock) qs.set("in_stock", "true");
    if (onlyToday) qs.set("available_today", "true");
    if (condition) qs.set("condition", condition);
    if (collection) qs.set("collection", collection);
    qs.set("sort", sort);
    api<{ cards?: TCard[] }>(`/catalog/list?${qs.toString()}`)
      .then((d) => setCards(Array.isArray(d.cards) ? d.cards : []))
      .catch(() => setCards([]));
  }, [category, sort, priceMax, debouncedQuery, brand, onlyStock, onlyToday, condition, collection]);

  function pickCategory(key: string) {
    setCategory(key);
    if (key) setParams({ category: key }); else setParams({});
  }

  const chip = (active: boolean) =>
    `tap shrink-0 rounded-full px-3.5 py-2 text-xs font-medium transition-colors ${
      active ? "bg-accent text-white" : "bg-surface text-text shadow-soft"
    }`;

  return (
    <div className="mx-auto max-w-md lg:max-w-none">
      <h1 className="text-2xl font-bold">Каталог</h1>

      {/* Desktop: сетка [sidebar фильтров | контент]; sidebar сворачивается */}
      <div className={`lg:mt-4 lg:grid lg:items-start lg:gap-8 ${sidebarOpen ? "lg:grid-cols-[260px_minmax(0,1fr)]" : ""}`}>
        {sidebarOpen && (
          <FilterSidebar
            category={category} onCategory={pickCategory}
            brands={brands} brand={brand} onBrand={setBrand}
            priceMax={priceMax} onPriceMax={setPriceMax}
            onlyStock={onlyStock} onOnlyStock={setOnlyStock}
            onlyToday={onlyToday} onOnlyToday={setOnlyToday}
            condition={condition} onCondition={setCondition}
          />
        )}

        <div className="min-w-0">
      {/* Sticky-блок: поиск + чипсы категорий (mobile) / поиск + сортировка (desktop) */}
      <div className="sticky top-0 z-20 -mx-4 bg-bg px-4 pb-1 pt-2 lg:mx-0 lg:px-0 lg:pt-0">
        <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl2 bg-surface px-4 shadow-soft">
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по каталогу"
            className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted"
          />
          {query && <button onClick={() => setQuery("")} className="text-muted">✕</button>}
        </div>

        {/* Desktop: сортировка + сворачивание фильтров в одной строке с поиском */}
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => setSort(s.key)} className={chip(sort === s.key)}>{s.label}</button>
          ))}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className={chip(false)}
            title={sidebarOpen ? "Скрыть фильтры" : "Показать фильтры"}
          >
            {sidebarOpen ? "⟨ Фильтры" : "Фильтры ⟩"}
          </button>
        </div>
        </div>

        <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
          {CATS.map((c) => (
            <button key={c.key} onClick={() => pickCategory(c.key)} className={chip(category === c.key)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Фильтры (mobile/tablet): сортировка, наличие, сегодня, бренд, цена */}
      <div className="no-scrollbar -mx-4 mt-2 flex items-center gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
        {SORTS.map((s) => (
          <button key={s.key} onClick={() => setSort(s.key)} className={chip(sort === s.key)}>{s.label}</button>
        ))}
        <button onClick={() => setOnlyStock(!onlyStock)} className={chip(onlyStock)}>В наличии</button>
        <button onClick={() => setOnlyToday(!onlyToday)} className={chip(onlyToday)}>Забрать сегодня</button>
        <select
          value={brand} onChange={(e) => setBrand(e.target.value)}
          className="tap shrink-0 appearance-none rounded-full bg-surface px-3.5 py-2 text-xs font-medium shadow-soft outline-none"
        >
          <option value="">Бренд</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <input
          value={priceMax} onChange={(e) => setPriceMax(e.target.value.replace(/\D/g, ""))}
          placeholder="Цена до, ₽" inputMode="numeric"
          className="w-24 shrink-0 rounded-full bg-surface px-3.5 py-2 text-xs shadow-soft outline-none placeholder:text-muted"
        />
      </div>

      {/* Сетка товаров: 2 / 3 (tablet) / 4 (desktop) / 5 (wide) */}
      {!cards ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="skeleton h-72 rounded-xl2" />)}
        </div>
      ) : cards.length === 0 ? (
        <div className="mt-14 text-center">
          <div className="text-4xl">🔍</div>
          <p className="mt-3 text-sm text-muted">Ничего не найдено. Попробуйте изменить фильтры.</p>
        </div>
      ) : (
        <div className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {cards.map((c) => <ProductCard key={c.id} card={c} onLead={setLead} />)}
        </div>
      )}

        </div>{/* /контент */}
      </div>{/* /desktop grid */}

      {lead && (
        <LeadForm
          productId={lead.id} productTitle={lead.title} productPrice={lead.price}
          source="catalog" onClose={() => setLead(null)}
        />
      )}
    </div>
  );
}

const CONDITIONS = [
  { key: "", label: "Любое" },
  { key: "new", label: "Новое" },
  { key: "used", label: "Б/у" },
  { key: "refurbished", label: "Восстановленное" },
];

/** Desktop-sidebar фильтров каталога (>=1024px). Только представление —
 *  вся логика фильтрации остаётся в Catalog (те же state/эффекты, что и mobile). */
function FilterSidebar({
  category, onCategory, brands, brand, onBrand, priceMax, onPriceMax,
  onlyStock, onOnlyStock, onlyToday, onOnlyToday, condition, onCondition,
}: {
  category: string; onCategory: (k: string) => void;
  brands: string[]; brand: string; onBrand: (v: string) => void;
  priceMax: string; onPriceMax: (v: string) => void;
  onlyStock: boolean; onOnlyStock: (v: boolean) => void;
  onlyToday: boolean; onOnlyToday: (v: boolean) => void;
  condition: string; onCondition: (v: string) => void;
}) {
  return (
    <aside className="hidden lg:block">
      <div className="rounded-xl2 bg-surface p-4 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Категория</p>
        <div className="mt-2 space-y-0.5">
          {CATS.map((c) => (
            <button
              key={c.key}
              onClick={() => onCategory(c.key)}
              className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors ${
                category === c.key ? "bg-accent/10 text-accent" : "hover:bg-mutedbg"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Бренд</p>
        <select
          value={brand} onChange={(e) => onBrand(e.target.value)}
          className="mt-2 w-full appearance-none rounded-xl border border-border bg-mutedbg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-accent/40"
        >
          <option value="">Все бренды</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Цена до, ₽</p>
        <input
          value={priceMax} onChange={(e) => onPriceMax(e.target.value.replace(/\D/g, ""))}
          placeholder="Например, 100000" inputMode="numeric"
          className="mt-2 w-full rounded-xl border border-border bg-mutedbg px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:ring-2 focus:ring-accent/40"
        />

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Наличие</p>
        <label className="mt-2 flex cursor-pointer items-center gap-2.5 rounded-xl px-1 py-1.5 text-sm">
          <input type="checkbox" checked={onlyStock} onChange={(e) => onOnlyStock(e.target.checked)}
            className="h-4 w-4 accent-[var(--app-accent)]" />
          В наличии
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl px-1 py-1.5 text-sm">
          <input type="checkbox" checked={onlyToday} onChange={(e) => onOnlyToday(e.target.checked)}
            className="h-4 w-4 accent-[var(--app-accent)]" />
          Забрать сегодня
        </label>

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Состояние</p>
        <div className="mt-2 space-y-0.5">
          {CONDITIONS.map((c) => (
            <button
              key={c.key}
              onClick={() => onCondition(c.key)}
              className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors ${
                condition === c.key ? "bg-accent/10 text-accent" : "hover:bg-mutedbg"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
