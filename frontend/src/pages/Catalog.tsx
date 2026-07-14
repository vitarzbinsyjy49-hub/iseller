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
    qs.set("sort", sort);
    api<{ cards?: TCard[] }>(`/catalog/list?${qs.toString()}`)
      .then((d) => setCards(Array.isArray(d.cards) ? d.cards : []))
      .catch(() => setCards([]));
  }, [category, sort, priceMax, debouncedQuery, brand, onlyStock, onlyToday]);

  function pickCategory(key: string) {
    setCategory(key);
    if (key) setParams({ category: key }); else setParams({});
  }

  const chip = (active: boolean) =>
    `tap shrink-0 rounded-full px-3.5 py-2 text-xs font-medium transition-colors ${
      active ? "bg-accent text-white" : "bg-surface text-text shadow-soft"
    }`;

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">Каталог</h1>

      {/* Sticky-блок: поиск + чипсы категорий (остаётся сверху при скролле) */}
      <div className="sticky top-0 z-20 -mx-4 bg-bg px-4 pb-1 pt-2">
        <div className="flex items-center gap-2 rounded-xl2 bg-surface px-4 shadow-soft">
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по каталогу"
            className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted"
          />
          {query && <button onClick={() => setQuery("")} className="text-muted">✕</button>}
        </div>

        <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
          {CATS.map((c) => (
            <button key={c.key} onClick={() => pickCategory(c.key)} className={chip(category === c.key)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Фильтры: сортировка, наличие, сегодня, бренд, цена */}
      <div className="no-scrollbar -mx-4 mt-2 flex items-center gap-2 overflow-x-auto px-4 pb-1">
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

      {/* Сетка товаров */}
      {!cards ? (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-72 rounded-xl2" />)}
        </div>
      ) : cards.length === 0 ? (
        <div className="mt-14 text-center">
          <div className="text-4xl">🔍</div>
          <p className="mt-3 text-sm text-muted">Ничего не найдено. Попробуйте изменить фильтры.</p>
        </div>
      ) : (
        <div className="stagger mt-4 grid grid-cols-2 gap-3">
          {cards.map((c) => <ProductCard key={c.id} card={c} onLead={setLead} />)}
        </div>
      )}

      {lead && (
        <LeadForm
          productId={lead.id} productTitle={lead.title} productPrice={lead.price}
          source="catalog" onClose={() => setLead(null)}
        />
      )}
    </div>
  );
}
