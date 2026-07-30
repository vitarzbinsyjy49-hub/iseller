import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { loadSearchHistory, pushSearchQuery } from "../lib/searchHistory";
import { loadCachedCategories, saveCachedCategories, sanitizeCategories, NavCategory } from "../lib/categoryCache";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import { ErrorState } from "../components/StateViews";

/** Р’РєР»Р°РґРєР° В«Р’СЃРµВ» вЂ” РµРґРёРЅСЃС‚РІРµРЅРЅР°СЏ, С‡С‚Рѕ РЅРµ РїСЂРёС…РѕРґРёС‚ СЃ СЃРµСЂРІРµСЂР°: РѕРЅР° СЃРЅРёРјР°РµС‚ С„РёР»СЊС‚СЂ,
 *  Р° РЅРµ РІС‹Р±РёСЂР°РµС‚ РєР°С‚РµРіРѕСЂРёСЋ. РЎР°Рј СЃРїРёСЃРѕРє РєР°С‚РµРіРѕСЂРёР№ СЃС‚СЂРѕРёС‚СЃСЏ РёР· РєР°С‚Р°Р»РѕРіР°
 *  (/catalog/categories), РїРѕСЌС‚РѕРјСѓ РІРєР»Р°РґРѕРє Р±РµР· С‚РѕРІР°СЂРѕРІ РЅРµ Р±С‹РІР°РµС‚: СЂР°РЅСЊС€Рµ Р·РґРµСЃСЊ
 *  Р±С‹Р» Р·Р°С…Р°СЂРґРєРѕР¶РµРЅРЅС‹Р№ СЃРїРёСЃРѕРє, Рё РІРєР»Р°РґРєРё В«DysonВ»/В«РђРєСЃРµСЃСЃСѓР°СЂС‹В» РѕС‚РєСЂС‹РІР°Р»Рё РїСѓСЃС‚РѕС‚Сѓ. */
const ALL_TAB = { key: "", label: "Р’СЃРµ" };
const SORTS = [
  { key: "popularity", label: "РџРѕРїСѓР»СЏСЂРЅС‹Рµ" },
  { key: "price_asc", label: "Р”РµС€РµРІР»Рµ" },
  { key: "price_desc", label: "Р”РѕСЂРѕР¶Рµ" },
];

/** РЎРѕРІРїР°РґР°РµС‚ СЃ limit РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ Сѓ GET /catalog/list (backend РЅРµ РјРµРЅСЏРµРј).
 *  РћС‚РІРµС‚ СЃРѕРґРµСЂР¶РёС‚ С‚РѕР»СЊРєРѕ `cards`, РїРѕР»СЏ total РЅРµС‚ вЂ” РїРѕСЌС‚РѕРјСѓ РїСЂРё Р·Р°РїРѕР»РЅРµРЅРЅРѕР№
 *  РґРѕ РїСЂРµРґРµР»Р° РІС‹РґР°С‡Рµ С‚РѕС‡РЅРѕРµ РѕР±С‰РµРµ РєРѕР»РёС‡РµСЃС‚РІРѕ РЅРµРёР·РІРµСЃС‚РЅРѕ, Рё РјС‹ РїРѕРєР°Р·С‹РІР°РµРј
 *  В«N+В», Р° РЅРµ СѓС‚РІРµСЂР¶РґР°РµРј РЅРµРІРµСЂРЅС‹Р№ РёС‚РѕРі. */
const LIST_LIMIT = 50;

/** Р СѓСЃСЃРєРёРµ СЃРєР»РѕРЅРµРЅРёСЏ РґР»СЏ СЃС‡С‘С‚С‡РёРєР°: 1 С‚РѕРІР°СЂ / 2 С‚РѕРІР°СЂР° / 5 С‚РѕРІР°СЂРѕРІ. */
function plural(n: number, one: string, few: string, many: string) {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return one;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return few;
  return many;
}

export default function Catalog() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [cardsError, setCardsError] = useState(false);
  const [category, setCategory] = useState(params.get("category") ?? "");
  // Р•РґРёРЅРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ РїРѕРёСЃРєР° вЂ” URL-РїР°СЂР°РјРµС‚СЂ `query` (С‚РѕС‚ Р¶Рµ, С‡С‚Рѕ РёСЃРїРѕР»СЊР·СѓРµС‚
  // С€Р°РїРєР° РЅР° desktop Рё Р¶РёРІС‹Рµ РїРѕРґСЃРєР°Р·РєРё РЅР° РіР»Р°РІРЅРѕР№). Р›РѕРєР°Р»СЊРЅС‹Р№ `q` РЅСѓР¶РµРЅ С‚РѕР»СЊРєРѕ
  // РґР»СЏ РјРіРЅРѕРІРµРЅРЅРѕРіРѕ РѕС‚РєР»РёРєР° РёРЅРїСѓС‚Р°; РІ URL РїРёС€РµРј СЃ debounce, СЃР°РјРѕ Р·РЅР°С‡РµРЅРёРµ РґР»СЏ
  // Р·Р°РїСЂРѕСЃР° Р±РµСЂС‘Рј РёР· URL (`urlQuery`) вЂ” РѕРґРёРЅ РёСЃС‚РѕС‡РЅРёРє РїСЂР°РІРґС‹, Р° РЅРµ РґРІР° СЃС‚РµР№С‚Р°.
  const urlQuery = params.get("query") ?? "";
  const [q, setQ] = useState(urlQuery);
  const [sort, setSort] = useState("popularity");
  // price_max/in_stock С‡РёС‚Р°СЋС‚СЃСЏ РёР· URL РїСЂРё РІС…РѕРґРµ (deep-link РёР· РїРѕРёСЃРєРѕРІС‹С… С‡РёРїРѕРІ),
  // РєР°Рє СЌС‚Рѕ СѓР¶Рµ РґРµР»Р°РµС‚ today=1; РїСЂРё РёР·РјРµРЅРµРЅРёРё РІ UI РѕР±СЂР°С‚РЅРѕ РІ URL РЅРµ РїРёС€СѓС‚СЃСЏ вЂ”
  // РїСЂРµР¶РЅРµРµ РїРѕРІРµРґРµРЅРёРµ С„РёР»СЊС‚СЂРѕРІ РЅРµ РјРµРЅСЏРµРј.
  const [priceMax, setPriceMax] = useState(params.get("price_max")?.replace(/\D/g, "") ?? "");
  // brand С‡РёС‚Р°РµС‚СЃСЏ РёР· URL РЅР°СЂР°РІРЅРµ СЃ category: РїРѕ РЅРµРјСѓ РїСЂРёС…РѕРґРёС‚ РїР»РёС‚РєР° Р±СЂРµРЅРґР°
  // СЃ РіР»Р°РІРЅРѕР№ (action_type=brand -> /catalog?brand=Dyson). Р‘РµР· СЌС‚РѕРіРѕ СЃСЃС‹Р»РєР°
  // РѕС‚РєСЂС‹РІР°Р»Р° РєР°С‚Р°Р»РѕРі РІРѕРѕР±С‰Рµ Р±РµР· С„РёР»СЊС‚СЂР°.
  const [brand, setBrand] = useState(params.get("brand") ?? "");
  const [brands, setBrands] = useState<string[]>([]);
  // РљР°С‚РµРіРѕСЂРёРё вЂ” РёР· РєР°С‚Р°Р»РѕРіР°, СЃ РјРіРЅРѕРІРµРЅРЅС‹Рј СЃС‚Р°СЂС‚РѕРј РёР· РєСЌС€Р° РїСЂРѕС€Р»РѕРіРѕ РѕС‚РІРµС‚Р°.
  const [cats, setCats] = useState<NavCategory[]>(() => loadCachedCategories());
  const tabs = [ALL_TAB, ...cats.map((c) => ({ key: c.key, label: c.label }))];
  const [onlyStock, setOnlyStock] = useState(params.get("in_stock") === "1");
  const [onlyToday, setOnlyToday] = useState(params.get("today") === "1");
  // Р§РёРїС‹ РЅРµРґР°РІРЅРёС… Р·Р°РїСЂРѕСЃРѕРІ РїСЂРё РїСѓСЃС‚РѕРј РїРѕРёСЃРєРµ (localStorage; С‡РёС‚Р°РµРј РЅР° С„РѕРєСѓСЃРµ)
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [condition, setCondition] = useState("");
  // Desktop: СЃРІРѕСЂР°С‡РёРІР°РµРјС‹Р№ sidebar С„РёР»СЊС‚СЂРѕРІ (>=1024px)
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const collection = params.get("collection") ?? "";

  useEffect(() => { track("catalog_opened", { category }); }, []);
  useEffect(() => {
    api<{ brands: string[] }>("/catalog/brands").then((d) => setBrands(d.brands)).catch(() => {});
    api<{ categories: NavCategory[] }>("/catalog/categories")
      .then((d) => { setCats(sanitizeCategories(d.categories)); saveCachedCategories(d.categories); })
      .catch(() => {});
  }, []);

  // РџРѕРґС…РІР°С‚РёС‚СЊ РІРЅРµС€РЅРµРµ РёР·РјРµРЅРµРЅРёРµ URL (РїРµСЂРµС…РѕРґ РёР· С€Р°РїРєРё/Р±Р°РЅРЅРµСЂР°/РїРѕРґСЃРєР°Р·РєРё РЅР° РіР»Р°РІРЅРѕР№).
  useEffect(() => { setQ(urlQuery); }, [urlQuery]);

  // Live-РїРѕРёСЃРє: debounce 250ms, РїРёС€РµРј РІ URL вЂ” РµРґРёРЅСЃС‚РІРµРЅРЅС‹Р№ РёСЃС‚РѕС‡РЅРёРє РїСЂР°РІРґС‹.
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

  // Р Р°РјРєР° РµСЃС‚СЊ Сѓ РѕР±РѕРёС… СЃРѕСЃС‚РѕСЏРЅРёР№ (Сѓ Р°РєС‚РёРІРЅРѕРіРѕ вЂ” РІ С†РІРµС‚ С„РѕРЅР°), РїРѕСЌС‚РѕРјСѓ РІС‹СЃРѕС‚Р°
  // РѕРґРёРЅР°РєРѕРІР°СЏ. РќР° mobile СЂР°РјРєР° РЅРµР°РєС‚РёРІРЅРѕРіРѕ РїСЂРѕР·СЂР°С‡РЅР° вЂ” РІРёРґ РЅРµ РјРµРЅСЏРµС‚СЃСЏ.
  const chip = (active: boolean) =>
    `tap shrink-0 rounded-full border px-3.5 py-2 text-xs font-medium transition-colors ${
      active ? "border-accent bg-accent text-white" : "border-transparent bg-surface text-text shadow-soft lg:border-border"
    }`;

  // Р—Р°РіРѕР»РѕРІРѕРє СЂР°Р·РґРµР»Р° Рё СЃС‡С‘С‚С‡РёРє вЂ” РёР· С„Р°РєС‚РёС‡РµСЃРєРѕРіРѕ РѕС‚РІРµС‚Р° API, Р±РµР· С…Р°СЂРґРєРѕРґР°.
  const sectionTitle = category ? tabs.find((c) => c.key === category)?.label ?? "РљР°С‚Р°Р»РѕРі" : "РљР°С‚Р°Р»РѕРі";
  const total = cards?.length ?? null;
  const countLabel =
    total === null
      ? null
      : `${total}${total >= LIST_LIMIT ? "+" : ""} ${plural(total, "С‚РѕРІР°СЂ", "С‚РѕРІР°СЂР°", "С‚РѕРІР°СЂРѕРІ")}`;

  return (
    <div className="mx-auto max-w-md lg:max-w-none">
      {/* Mobile: РїСЂРµР¶РЅРёР№ Р·Р°РіРѕР»РѕРІРѕРє РЅР°Рґ С„РёР»СЊС‚СЂР°РјРё. РќР° desktop Р·Р°РіРѕР»РѕРІРѕРє СЂР°Р·РґРµР»Р°
          Р¶РёРІС‘С‚ РІ РєРѕР»РѕРЅРєРµ РєРѕРЅС‚РµРЅС‚Р° (СЃРј. title row РЅРёР¶Рµ) вЂ” С‚Р°Рє РѕРЅ РІС‹СЂРѕРІРЅРµРЅ СЃ
          toolbar Рё СЃРµС‚РєРѕР№, Р° РЅРµ СЂР°СЃС‚СЏРЅСѓС‚ РїРѕРІРµСЂС… РІСЃРµР№ С€РёСЂРёРЅС‹ РІРєР»СЋС‡Р°СЏ sidebar. */}
      <h1 className="text-2xl font-bold lg:hidden">РљР°С‚Р°Р»РѕРі</h1>

      {/* Desktop: СЃРµС‚РєР° [sidebar С„РёР»СЊС‚СЂРѕРІ | РєРѕРЅС‚РµРЅС‚]; sidebar СЃРІРѕСЂР°С‡РёРІР°РµС‚СЃСЏ.
          lg:mt-0 вЂ” РѕС‚СЃС‚СѓРї РѕС‚ С€Р°РїРєРё Р·Р°РґР°С‘С‚ padding-top Сѓ <main> (lg:pt-6 = 24px),
          РёРЅР°С‡Рµ Рє РЅРµРјСѓ РїСЂРёР±Р°РІР»СЏР»СЃСЏ РµС‰С‘ mt-4 Рё СЂР°Р·СЂС‹РІ СѓС…РѕРґРёР» Р·Р° 32px. */}
      <div className={`lg:mt-0 lg:grid lg:items-start lg:gap-8 ${sidebarOpen ? "lg:grid-cols-[260px_minmax(0,1fr)]" : ""}`}>
        {sidebarOpen && (
          <FilterSidebar
            category={category} onCategory={pickCategory} tabs={tabs}
            brands={brands} brand={brand} onBrand={setBrand}
            priceMax={priceMax} onPriceMax={setPriceMax}
            onlyStock={onlyStock} onOnlyStock={setOnlyStock}
            onlyToday={onlyToday} onOnlyToday={setOnlyToday}
            condition={condition} onCondition={setCondition}
          />
        )}

        <div className="min-w-0">
      {/* ===== Desktop title row: СЂР°Р·РґРµР» + С„Р°РєС‚РёС‡РµСЃРєРѕРµ РєРѕР»РёС‡РµСЃС‚РІРѕ =====
          РћС‚СЃС‚СѓРїС‹: РѕС‚ С€Р°РїРєРё 24px (padding-top <main>), РґРѕ toolbar 16px (mb-4). */}
      <div className="mb-4 hidden lg:block">
        <h1 className="text-2xl font-bold leading-8">{sectionTitle}</h1>
        {countLabel && <p className="mt-1 text-sm text-muted">{countLabel}</p>}
      </div>

      {/* ===== Р•РґРёРЅР°СЏ sticky-РїР°РЅРµР»СЊ РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ =====
          Р’СЃС‘, С‡С‚Рѕ СЃРєСЂРѕР»Р»РёС‚СЃСЏ РІРјРµСЃС‚Рµ СЃ С€Р°РїРєРѕР№ РєР°С‚Р°Р»РѕРіР°, Р¶РёРІС‘С‚ РІ РћР”РќРћРњ sticky-Р±Р»РѕРєРµ
          СЃ РЅРµРїСЂРѕР·СЂР°С‡РЅС‹Рј С„РѕРЅРѕРј вЂ” СЂР°РЅСЊС€Рµ РїРѕРёСЃРє/С‡РёРїСЃС‹ РєР°С‚РµРіРѕСЂРёР№ Р±С‹Р»Рё РІ sticky-Р±Р»РѕРєРµ,
          Р° СЃС‚СЂРѕРєР° СЃРѕСЂС‚РёСЂРѕРІРєРё/С„РёР»СЊС‚СЂРѕРІ С€Р»Р° РѕС‚РґРµР»СЊРЅС‹Рј РЅРµСЃРєР»РµРµРЅРЅС‹Рј Р±Р»РѕРєРѕРј РЅРёР¶Рµ Рё РїСЂРё
          СЃРєСЂРѕР»Р»Рµ В«РЅР°РµР·Р¶Р°Р»Р°В» РЅР° РЅРµС‘ Р¶Рµ Рё РЅР° РїРµСЂРІС‹Р№ СЂСЏРґ РєР°СЂС‚РѕС‡РµРє. РўРµРїРµСЂСЊ РѕРґРёРЅ Р±Р»РѕРє,
          РѕРґРЅР° РЅРёР¶РЅСЏСЏ РіСЂР°РЅРёС†Р°, РЅР°Р»РѕР¶РµРЅРёСЏ РЅРµС‚. */}
      {/* Mobile: РїР°РЅРµР»СЊ РѕСЃС‚Р°С‘С‚СЃСЏ sticky. РЎРґРІРёРі СЂР°РІРµРЅ padding-top СЃРєСЂРѕР»Р»-РєРѕРЅС‚РµР№РЅРµСЂР°
          <main>: sticky РїСЂРёР¶РёРјР°РµС‚СЃСЏ Рє РєСЂР°СЋ content-box, РїРѕСЌС‚РѕРјСѓ СЃ top-0 РїР°РЅРµР»СЊ
          Р·Р°РІРёСЃР°РµС‚ СЂРѕРІРЅРѕ РЅР° РІРµР»РёС‡РёРЅСѓ СЌС‚РѕРіРѕ padding, Рё РІ РїРѕР»РѕСЃРµ РїСЂРѕСЃРІРµС‡РёРІР°СЋС‚
          СЃРєСЂРѕР»Р»СЏС‰РёРµСЃСЏ РєР°СЂС‚РѕС‡РєРё (С‚Р° СЃР°РјР°СЏ В«С‰РµР»СЊВ»). main pt-3 (12px) в†’ -top-3.
          РџСЂРё СЃРјРµРЅРµ pt Сѓ <main> Р·РЅР°С‡РµРЅРёРµ РЅСѓР¶РЅРѕ РјРµРЅСЏС‚СЊ СЃРёРЅС…СЂРѕРЅРЅРѕ.

          Desktop (v5.2.4): РїР°РЅРµР»СЊ СЃС‚Р°С‚РёС‡РЅР° (lg:static) Рё Р·Р°РЅРёРјР°РµС‚ РјРµСЃС‚Рѕ РІ РїРѕС‚РѕРєРµ вЂ”
          РѕС‚СЂРёС†Р°С‚РµР»СЊРЅР°СЏ РєРѕРјРїРµРЅСЃР°С†РёСЏ РЅСѓР¶РЅР° С‚РѕР»СЊРєРѕ sticky-СЂРµР¶РёРјСѓ, РЅР° desktop РѕРЅР°
          Р»РёС€СЊ СЃРѕР·РґР°РІР°Р»Р° РЅР°Р»РѕР¶РµРЅРёРµ РЅР° РєР°СЂС‚РѕС‡РєРё. */}
      <div className="seam-guard sticky -top-3 z-20 -mx-4 space-y-2 border-b border-border bg-bg px-4 pb-2.5 pt-2 lg:static lg:top-auto lg:mx-0 lg:border-0 lg:px-0 lg:pb-0 lg:pt-0">
        <div className="flex items-center gap-2">
        {/* РџРѕРёСЃРє РєР°С‚Р°Р»РѕРіР° вЂ” РўРћР›Р¬РљРћ mobile/tablet. РќР° desktop РµРґРёРЅСЃС‚РІРµРЅРЅС‹Р№ РїРѕРёСЃРє вЂ”
            РІ С€Р°РїРєРµ (DesktopHeader), РїРёС€РµС‚ РІ С‚РѕС‚ Р¶Рµ URL-РїР°СЂР°РјРµС‚СЂ `query`. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl2 bg-surface px-4 shadow-soft lg:hidden">
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="РџРѕРёСЃРє РїРѕ РєР°С‚Р°Р»РѕРіСѓ"
            aria-label="РџРѕРёСЃРє РїРѕ РєР°С‚Р°Р»РѕРіСѓ"
            onFocus={() => {
              setSearchFocused(true);
              setRecentQueries(loadSearchHistory());
              track("search_focused", { source: "catalog" });
            }}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const trimmed = q.trim();
                if (trimmed.length >= 2) {
                  pushSearchQuery(trimmed);
                  track("search_query_submitted", { query_length: trimmed.length, source: "catalog_enter" });
                }
                e.currentTarget.blur(); // СЃРїСЂСЏС‚Р°С‚СЊ РєР»Р°РІРёР°С‚СѓСЂСѓ вЂ” СЂРµР·СѓР»СЊС‚Р°С‚С‹ СѓР¶Рµ РЅР° СЌРєСЂР°РЅРµ
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted"
          />
          {q && <button onClick={() => setQ("")} aria-label="РћС‡РёСЃС‚РёС‚СЊ РїРѕРёСЃРє" className="text-muted">вњ•</button>}
        </div>

        {/* Desktop controls row: СЃРѕСЂС‚РёСЂРѕРІРєРё Рё В«Р’ РЅР°Р»РёС‡РёРёВ» СЃР»РµРІР°, В«Р¤РёР»СЊС‚СЂС‹В»
            РїСЂРёР¶Р°С‚С‹ РІРїСЂР°РІРѕ С‡РµСЂРµР· ml-auto Сѓ СЃР°РјРѕР№ РєРЅРѕРїРєРё вЂ” Р° РЅРµ justify-end Сѓ
            РІСЃРµР№ РіСЂСѓРїРїС‹, РёР·-Р·Р° РєРѕС‚РѕСЂРѕРіРѕ РєРЅРѕРїРєРё Р»РёРїР»Рё Рє РїСЂР°РІРѕРјСѓ РєСЂР°СЋ РІРЅРµ РѕР±С‰РµР№
            СЃРµС‚РєРё. flex-wrap: РЅР° 1024вЂ“1199px СЃС‚СЂРѕРєР° РїРµСЂРµРЅРѕСЃРёС‚СЃСЏ Р±РµР· РЅР°Р»РѕР¶РµРЅРёР№. */}
        <div className="hidden lg:flex lg:w-full lg:flex-wrap lg:items-center lg:gap-2.5">
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => setSort(s.key)} className={chip(sort === s.key)}>{s.label}</button>
          ))}
          <button onClick={() => setOnlyStock(!onlyStock)} className={chip(onlyStock)}>Р’ РЅР°Р»РёС‡РёРё</button>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className={`${chip(false)} lg:ml-auto`}
            title={sidebarOpen ? "РЎРєСЂС‹С‚СЊ С„РёР»СЊС‚СЂС‹" : "РџРѕРєР°Р·Р°С‚СЊ С„РёР»СЊС‚СЂС‹"}
          >
            {sidebarOpen ? "вџЁ Р¤РёР»СЊС‚СЂС‹" : "Р¤РёР»СЊС‚СЂС‹ вџ©"}
          </button>
        </div>
        </div>

        {/* РќРµРґР°РІРЅРёРµ Р·Р°РїСЂРѕСЃС‹ РїСЂРё РїСѓСЃС‚РѕРј С„РѕРєСѓСЃРµ РїРѕРёСЃРєР° (РёСЃС‚РѕСЂРёСЏ РёР· localStorage).
            onMouseDown + preventDefault: С‚Р°Рї РїРѕ С‡РёРїСѓ РЅРµ Р±Р»СЋСЂРёС‚ РёРЅРїСѓС‚, Р·РЅР°С‡РµРЅРёРµ
            РїРѕРґСЃС‚Р°РІР»СЏРµС‚СЃСЏ РґРѕ Р·Р°РєСЂС‹С‚РёСЏ СЂСЏРґР°. */}
        {searchFocused && !q.trim() && recentQueries.length > 0 && (
          <div className="no-scrollbar fade-in -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 lg:hidden">
            <span className="shrink-0 text-[11px] font-medium text-muted">Р’С‹ РёСЃРєР°Р»Рё:</span>
            {recentQueries.map((h) => (
              <button
                key={h}
                onMouseDown={(e) => { e.preventDefault(); setQ(h); }}
                className="tap max-w-[180px] shrink-0 truncate rounded-full bg-surface px-3 py-1.5 text-xs font-medium shadow-soft"
              >
                {h}
              </button>
            ))}
          </div>
        )}

        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 lg:hidden">
          {tabs.map((c) => (
            <button key={c.key} onClick={() => pickCategory(c.key)} className={chip(category === c.key)}>
              {c.label}
            </button>
          ))}
        </div>

        {/* Р¤РёР»СЊС‚СЂС‹ (mobile/tablet): СЃРѕСЂС‚РёСЂРѕРІРєР°, РЅР°Р»РёС‡РёРµ, СЃРµРіРѕРґРЅСЏ, Р±СЂРµРЅРґ, С†РµРЅР° вЂ”
            РІ РўРћРњ Р–Р• sticky-Р±Р»РѕРєРµ, С‡С‚Рѕ Рё РїРѕРёСЃРє/РєР°С‚РµРіРѕСЂРёРё (СЃРј. РєРѕРјРјРµРЅС‚Р°СЂРёР№ РІС‹С€Рµ). */}
        <div className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 lg:hidden">
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => setSort(s.key)} className={chip(sort === s.key)}>{s.label}</button>
          ))}
          <button onClick={() => setOnlyStock(!onlyStock)} className={chip(onlyStock)}>Р’ РЅР°Р»РёС‡РёРё</button>
          <button onClick={() => setOnlyToday(!onlyToday)} className={chip(onlyToday)}>Р—Р°Р±СЂР°С‚СЊ СЃРµРіРѕРґРЅСЏ</button>
          <select
            value={brand} onChange={(e) => setBrand(e.target.value)}
            className="tap shrink-0 appearance-none rounded-full bg-surface px-3.5 py-2 text-xs font-medium shadow-soft outline-none"
          >
            <option value="">Р‘СЂРµРЅРґ</option>
            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <input
            value={priceMax} onChange={(e) => setPriceMax(e.target.value.replace(/\D/g, ""))}
            placeholder="Р¦РµРЅР° РґРѕ, в‚Ѕ" inputMode="numeric"
            className="w-24 shrink-0 rounded-full bg-surface px-3.5 py-2 text-xs shadow-soft outline-none placeholder:text-muted"
          />
        </div>
      </div>

      {/* РЎРµС‚РєР° С‚РѕРІР°СЂРѕРІ: 2 / 3 (tablet) / 4 (desktop) / 5 (wide) */}
      {cardsError ? (
        <div className="mt-6"><ErrorState message="РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ С‚РѕРІР°СЂС‹" onRetry={load} /></div>
      ) : !cards ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:mt-5 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="skeleton h-72 rounded-xl2" />)}
        </div>
      ) : cards.length === 0 ? (
        <NoResults
          query={urlQuery}
          onAskAi={() => {
            track("search_ai_escalated", { source: "catalog_no_results", query_length: urlQuery.length });
            navigate(urlQuery ? `/ai?q=${encodeURIComponent(urlQuery)}&auto=1` : "/ai");
          }}
          onReset={() => {
            track("empty_state_action_clicked", { source: "catalog_no_results_reset" });
            setQ(""); setCategory(""); setBrand(""); setPriceMax("");
            setOnlyStock(false); setOnlyToday(false); setCondition("");
            setParams(new URLSearchParams(), { replace: true });
          }}
        />
      ) : (
        <div className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:mt-5 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {cards.map((c) => <ProductCard key={c.id} card={c} />)}
        </div>
      )}

        </div>{/* /РєРѕРЅС‚РµРЅС‚ */}
      </div>{/* /desktop grid */}
    </div>
  );
}

/** РџСѓСЃС‚Р°СЏ РІС‹РґР°С‡Р° РєР°С‚Р°Р»РѕРіР° вЂ” РЅРµ С‚СѓРїРёРє: Р·Р°РїСЂРѕСЃ СЃРѕС…СЂР°РЅС‘РЅ РІ СЃС‚СЂРѕРєРµ РїРѕРёСЃРєР°, РјРѕР¶РЅРѕ
 *  РёР·РјРµРЅРёС‚СЊ С„РѕСЂРјСѓР»РёСЂРѕРІРєСѓ, СЃРїСЂРѕСЃРёС‚СЊ AI (СЃ prefill) РёР»Рё СЃР±СЂРѕСЃРёС‚СЊ С„РёР»СЊС‚СЂС‹. */
function NoResults({ query, onAskAi, onReset }: {
  query: string; onAskAi: () => void; onReset: () => void;
}) {
  return (
    <div className="fade-in mt-6 rounded-xl2 bg-surface p-6 text-center shadow-soft">
      <div className="text-3xl">рџ”Ќ</div>
      <p className="mt-2 text-[15px] font-bold">
        {query ? <>РџРѕ Р·Р°РїСЂРѕСЃСѓ В«{query}В» РЅРёС‡РµРіРѕ РЅРµ РЅР°С€Р»РѕСЃСЊ</> : "РќРёС‡РµРіРѕ РЅРµ РЅР°Р№РґРµРЅРѕ"}
      </p>
      <p className="mx-auto mt-1 max-w-xs text-[13px] text-muted">
        РџРѕРїСЂРѕР±СѓР№С‚Рµ РёР·РјРµРЅРёС‚СЊ С„РѕСЂРјСѓР»РёСЂРѕРІРєСѓ РёР»Рё С„РёР»СЊС‚СЂС‹ вЂ” Р»РёР±Рѕ РѕРїРёС€РёС‚Рµ Р·Р°РґР°С‡Сѓ AI, РѕРЅ РёС‰РµС‚ РїРѕ СЃРјС‹СЃР»Сѓ.
      </p>
      <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2">
        <button onClick={onAskAi}
          className="tap rounded-field bg-accent px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-accentdark">
          вњЁ РЎРїСЂРѕСЃРёС‚СЊ AI{query ? ` В«${query.length > 24 ? `${query.slice(0, 24)}вЂ¦` : query}В»` : ""}
        </button>
        <button onClick={onReset}
          className="tap rounded-field bg-mutedbg px-4 py-2.5 text-[13px] font-semibold text-text">
          РЎР±СЂРѕСЃРёС‚СЊ С„РёР»СЊС‚СЂС‹
        </button>
      </div>
    </div>
  );
}

const CONDITIONS = [
  { key: "", label: "Р›СЋР±РѕРµ" },
  { key: "new", label: "РќРѕРІРѕРµ" },
  { key: "used", label: "Р‘/Сѓ" },
  { key: "refurbished", label: "Р’РѕСЃСЃС‚Р°РЅРѕРІР»РµРЅРЅРѕРµ" },
];

/** Desktop-sidebar С„РёР»СЊС‚СЂРѕРІ РєР°С‚Р°Р»РѕРіР° (>=1024px). РўРѕР»СЊРєРѕ РїСЂРµРґСЃС‚Р°РІР»РµРЅРёРµ вЂ”
 *  РІСЃСЏ Р»РѕРіРёРєР° С„РёР»СЊС‚СЂР°С†РёРё РѕСЃС‚Р°С‘С‚СЃСЏ РІ Catalog (С‚Рµ Р¶Рµ state/СЌС„С„РµРєС‚С‹, С‡С‚Рѕ Рё mobile). */
function FilterSidebar({
  category, onCategory, tabs, brands, brand, onBrand, priceMax, onPriceMax,
  onlyStock, onOnlyStock, onlyToday, onOnlyToday, condition, onCondition,
}: {
  category: string; onCategory: (k: string) => void;
  /** Р’РєР»Р°РґРєРё РєР°С‚РµРіРѕСЂРёР№ РїСЂРёС…РѕРґСЏС‚ СЃРІРµСЂС…Сѓ: СЃРїРёСЃРѕРє СЃС‚СЂРѕРёС‚СЃСЏ РёР· РєР°С‚Р°Р»РѕРіР°,
   *  Р° РЅРµ РёР· РєРѕРЅСЃС‚Р°РЅС‚С‹ вЂ” СЃРІРѕРµРіРѕ РёСЃС‚РѕС‡РЅРёРєР° Сѓ СЃР°Р№РґР±Р°СЂР° Р±С‹С‚СЊ РЅРµ РґРѕР»Р¶РЅРѕ. */
  tabs: { key: string; label: string }[];
  brands: string[]; brand: string; onBrand: (v: string) => void;
  priceMax: string; onPriceMax: (v: string) => void;
  onlyStock: boolean; onOnlyStock: (v: boolean) => void;
  onlyToday: boolean; onOnlyToday: (v: boolean) => void;
  condition: string; onCondition: (v: string) => void;
}) {
  return (
    <aside className="hidden lg:block">
      <div className="rounded-xl2 bg-surface p-4 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">РљР°С‚РµРіРѕСЂРёСЏ</p>
        <div className="mt-2 space-y-0.5">
          {tabs.map((c) => (
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

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Р‘СЂРµРЅРґ</p>
        <select
          value={brand} onChange={(e) => onBrand(e.target.value)}
          className="mt-2 w-full appearance-none rounded-xl border border-border bg-mutedbg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-accent/40"
        >
          <option value="">Р’СЃРµ Р±СЂРµРЅРґС‹</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Р¦РµРЅР° РґРѕ, в‚Ѕ</p>
        <input
          value={priceMax} onChange={(e) => onPriceMax(e.target.value.replace(/\D/g, ""))}
          placeholder="РќР°РїСЂРёРјРµСЂ, 100000" inputMode="numeric"
          className="mt-2 w-full rounded-xl border border-border bg-mutedbg px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:ring-2 focus:ring-accent/40"
        />

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">РќР°Р»РёС‡РёРµ</p>
        <label className="mt-2 flex cursor-pointer items-center gap-2.5 rounded-xl px-1 py-1.5 text-sm">
          <input type="checkbox" checked={onlyStock} onChange={(e) => onOnlyStock(e.target.checked)}
            className="h-4 w-4 accent-[rgb(var(--app-accent))]" />
          Р’ РЅР°Р»РёС‡РёРё
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl px-1 py-1.5 text-sm">
          <input type="checkbox" checked={onlyToday} onChange={(e) => onOnlyToday(e.target.checked)}
            className="h-4 w-4 accent-[rgb(var(--app-accent))]" />
          Р—Р°Р±СЂР°С‚СЊ СЃРµРіРѕРґРЅСЏ
        </label>

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">РЎРѕСЃС‚РѕСЏРЅРёРµ</p>
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
