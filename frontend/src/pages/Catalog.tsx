import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";
import { ErrorState, EmptyState } from "../components/StateViews";

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

/** Совпадает с limit по умолчанию у GET /catalog/list (backend не меняем).
 *  Ответ содержит только `cards`, поля total нет — поэтому при заполненной
 *  до предела выдаче точное общее количество неизвестно, и мы показываем
 *  «N+», а не утверждаем неверный итог. */
const LIST_LIMIT = 50;

/** Русские склонения для счётчика: 1 товар / 2 товара / 5 товаров. */
function plural(n: number, one: string, few: string, many: string) {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return one;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return few;
  return many;
}

export default function Catalog() {
  const [params, setParams] = useSearchParams();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [cardsError, setCardsError] = useState(false);
  const [category, setCategory] = useState(params.get("category") ?? "");
  // Единое состояние поиска — URL-параметр `query` (тот же, что использует
  // шапка на desktop и живые подсказки на главной). Локальный `q` нужен только
  // для мгновенного отклика инпута; в URL пишем с debounce, само значение для
  // запроса берём из URL (`urlQuery`) — один источник правды, а не два стейта.
  const urlQuery = params.get("query") ?? "";
  const [q, setQ] = useState(urlQuery);
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

  // Подхватить внешнее изменение URL (переход из шапки/баннера/подсказки на главной).
  useEffect(() => { setQ(urlQuery); }, [urlQuery]);

  // Live-поиск: debounce 250ms, пишем в URL — единственный источник правды.
  useEffect(() => {
    const t = setTimeout(() => {
      const trimmed = q.trim();
      if (trimmed === urlQuery) return;
      const next = new URLSearchParams(params);
      if (trimmed) next.set("query", trimmed); else next.delete("query");
      setParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    setCards(null);
    setCardsError(false);
    const qs = new URLSearchParams();
    if (category) qs.set("category", category);
    if (urlQuery) qs.set("query", urlQuery);
    if (priceMax) qs.set("price_max", priceMax);
    if (brand) qs.set("brand", brand);
    if (onlyStock) qs.set("in_stock", "true");
    if (onlyToday) qs.set("available_today", "true");
    if (condition) qs.set("condition", condition);
    if (collection) qs.set("collection", collection);
    qs.set("sort", sort);
    api<{ cards?: TCard[] }>(`/catalog/list?${qs.toString()}`)
      .then((d) => setCards(Array.isArray(d.cards) ? d.cards : []))
      .catch(() => { setCards([]); setCardsError(true); });
  }, [category, sort, priceMax, urlQuery, brand, onlyStock, onlyToday, condition, collection]);

  useEffect(() => { load(); }, [load]);

  function pickCategory(key: string) {
    setCategory(key);
    const next = new URLSearchParams(params);
    if (key) next.set("category", key); else next.delete("category");
    setParams(next);
  }

  // Рамка есть у обоих состояний (у активного — в цвет фона), поэтому высота
  // одинаковая. На mobile рамка неактивного прозрачна — вид не меняется.
  const chip = (active: boolean) =>
    `tap shrink-0 rounded-full border px-3.5 py-2 text-xs font-medium transition-colors ${
      active ? "border-accent bg-accent text-white" : "border-transparent bg-surface text-text shadow-soft lg:border-border"
    }`;

  // Заголовок раздела и счётчик — из фактического ответа API, без хардкода.
  const sectionTitle = category ? CATS.find((c) => c.key === category)?.label ?? "Каталог" : "Каталог";
  const total = cards?.length ?? null;
  const countLabel =
    total === null
      ? null
      : `${total}${total >= LIST_LIMIT ? "+" : ""} ${plural(total, "товар", "товара", "товаров")}`;

  return (
    <div className="mx-auto max-w-md lg:max-w-none">
      {/* Mobile: прежний заголовок над фильтрами. На desktop заголовок раздела
          живёт в колонке контента (см. title row ниже) — так он выровнен с
          toolbar и сеткой, а не растянут поверх всей ширины включая sidebar. */}
      <h1 className="text-2xl font-bold lg:hidden">Каталог</h1>

      {/* Desktop: сетка [sidebar фильтров | контент]; sidebar сворачивается.
          lg:mt-0 — отступ от шапки задаёт padding-top у <main> (lg:pt-6 = 24px),
          иначе к нему прибавлялся ещё mt-4 и разрыв уходил за 32px. */}
      <div className={`lg:mt-0 lg:grid lg:items-start lg:gap-8 ${sidebarOpen ? "lg:grid-cols-[260px_minmax(0,1fr)]" : ""}`}>
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
      {/* ===== Desktop title row: раздел + фактическое количество =====
          Отступы: от шапки 24px (padding-top <main>), до toolbar 16px (mb-4). */}
      <div className="mb-4 hidden lg:block">
        <h1 className="text-2xl font-bold leading-8">{sectionTitle}</h1>
        {countLabel && <p className="mt-1 text-sm text-muted">{countLabel}</p>}
      </div>

      {/* ===== Единая sticky-панель инструментов =====
          Всё, что скроллится вместе с шапкой каталога, живёт в ОДНОМ sticky-блоке
          с непрозрачным фоном — раньше поиск/чипсы категорий были в sticky-блоке,
          а строка сортировки/фильтров шла отдельным несклеенным блоком ниже и при
          скролле «наезжала» на неё же и на первый ряд карточек. Теперь один блок,
          одна нижняя граница, наложения нет. */}
      {/* Mobile: панель остаётся sticky. Сдвиг равен padding-top скролл-контейнера
          <main>: sticky прижимается к краю content-box, поэтому с top-0 панель
          зависает ровно на величину этого padding, и в полосе просвечивают
          скроллящиеся карточки (та самая «щель»). main pt-3 (12px) → -top-3.
          При смене pt у <main> значение нужно менять синхронно.

          Desktop (v5.2.4): панель статична (lg:static) и занимает место в потоке —
          отрицательная компенсация нужна только sticky-режиму, на desktop она
          лишь создавала наложение на карточки. */}
      <div className="seam-guard sticky -top-3 z-20 -mx-4 space-y-2 border-b border-border bg-bg px-4 pb-2.5 pt-2 lg:static lg:top-auto lg:mx-0 lg:border-0 lg:px-0 lg:pb-0 lg:pt-0">
        <div className="flex items-center gap-2">
        {/* Поиск каталога — ТОЛЬКО mobile/tablet. На desktop единственный поиск —
            в шапке (DesktopHeader), пишет в тот же URL-параметр `query`. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl2 bg-surface px-4 shadow-soft lg:hidden">
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по каталогу"
            className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted"
          />
          {q && <button onClick={() => setQ("")} className="text-muted">✕</button>}
        </div>

        {/* Desktop controls row: сортировки и «В наличии» слева, «Фильтры»
            прижаты вправо через ml-auto у самой кнопки — а не justify-end у
            всей группы, из-за которого кнопки липли к правому краю вне общей
            сетки. flex-wrap: на 1024–1199px строка переносится без наложений. */}
        <div className="hidden lg:flex lg:w-full lg:flex-wrap lg:items-center lg:gap-2.5">
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => setSort(s.key)} className={chip(sort === s.key)}>{s.label}</button>
          ))}
          <button onClick={() => setOnlyStock(!onlyStock)} className={chip(onlyStock)}>В наличии</button>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className={`${chip(false)} lg:ml-auto`}
            title={sidebarOpen ? "Скрыть фильтры" : "Показать фильтры"}
          >
            {sidebarOpen ? "⟨ Фильтры" : "Фильтры ⟩"}
          </button>
        </div>
        </div>

        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 lg:hidden">
          {CATS.map((c) => (
            <button key={c.key} onClick={() => pickCategory(c.key)} className={chip(category === c.key)}>
              {c.label}
            </button>
          ))}
        </div>

        {/* Фильтры (mobile/tablet): сортировка, наличие, сегодня, бренд, цена —
            в ТОМ ЖЕ sticky-блоке, что и поиск/категории (см. комментарий выше). */}
        <div className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 lg:hidden">
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
      </div>

      {/* Сетка товаров: 2 / 3 (tablet) / 4 (desktop) / 5 (wide) */}
      {cardsError ? (
        <div className="mt-6"><ErrorState message="Не удалось загрузить товары" onRetry={load} /></div>
      ) : !cards ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:mt-5 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="skeleton h-72 rounded-xl2" />)}
        </div>
      ) : cards.length === 0 ? (
        <EmptyState message="Ничего не найдено. Попробуйте изменить фильтры." />
      ) : (
        <div className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:mt-5 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
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
