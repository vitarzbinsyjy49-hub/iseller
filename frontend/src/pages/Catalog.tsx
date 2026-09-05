import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { loadSearchHistory, pushSearchQuery } from "../lib/searchHistory";
import { loadCachedCategories, saveCachedCategories, sanitizeCategories, NavCategory } from "../lib/categoryCache";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import { ErrorState } from "../components/StateViews";
import { Icon } from "../components/icons";
import { enterRefCallback } from "../lib/useEnter";
import { useHideOnScroll } from "../lib/useHideOnScroll";
import { CatalogFilterSheet, CatalogSortSheet } from "../components/CatalogFilterSheet";
import { activeFilterCount, filterButtonLabel, sortButtonLabel, type CatalogFilters } from "../lib/catalogFilters";

/** Вкладка «Все» — единственная, что не приходит с сервера: она снимает фильтр,
 *  а не выбирает категорию. Сам список категорий строится из каталога
 *  (/catalog/categories), поэтому вкладок без товаров не бывает: раньше здесь
 *  был захардкоженный список, и вкладки «Dyson»/«Аксессуары» открывали пустоту. */
const ALL_TAB = { key: "", label: "Все" };
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
  // Панель инструментов уезжает при прокрутке вниз (см. комментарий у неё).
  const hideToolbarRef = useHideOnScroll();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [cardsError, setCardsError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const catalogRequest = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState(params.get("category") ?? "");
  // Единое состояние поиска — URL-параметр `query` (тот же, что использует
  // шапка на desktop и живые подсказки на главной). Локальный `q` нужен только
  // для мгновенного отклика инпута; в URL пишем с debounce, само значение для
  // запроса берём из URL (`urlQuery`) — один источник правды, а не два стейта.
  const urlQuery = params.get("query") ?? "";
  const [q, setQ] = useState(urlQuery);
  const [sort, setSort] = useState("popularity");
  // price_max/in_stock читаются из URL при входе (deep-link из поисковых чипов),
  // как это уже делает today=1; при изменении в UI обратно в URL не пишутся —
  // прежнее поведение фильтров не меняем.
  const [priceMax, setPriceMax] = useState(params.get("price_max")?.replace(/\D/g, "") ?? "");
  // brand читается из URL наравне с category: по нему приходит плитка бренда
  // с главной (action_type=brand -> /catalog?brand=Dyson). Без этого ссылка
  // открывала каталог вообще без фильтра.
  const [brand, setBrand] = useState(params.get("brand") ?? "");
  const [brands, setBrands] = useState<string[]>([]);
  // Какая шторка открыта. Одна на две: сортировка и фильтры физически не могут
  // быть открыты одновременно, и отдельные флаги пришлось бы держать в согласии.
  const [sheet, setSheet] = useState<null | "sort" | "filters">(null);
  // Категории — из каталога, с мгновенным стартом из кэша прошлого ответа.
  // Кэш ГЛОБАЛЬНЫЙ, поэтому при входе с брендом им пользоваться нельзя: иначе
  // на витрине Dyson на мгновение появился бы ряд всего магазина со
  // «смартфонами» — ровно то, что мы убираем.
  const [cats, setCats] = useState<NavCategory[]>(
    () => (params.get("brand") ? [] : loadCachedCategories()),
  );
  const tabs = [ALL_TAB, ...cats.map((c) => ({ key: c.key, label: c.label }))];
  const [onlyStock, setOnlyStock] = useState(params.get("in_stock") === "1");
  const [onlyToday, setOnlyToday] = useState(params.get("today") === "1");
  // Чипы недавних запросов при пустом поиске (localStorage; читаем на фокусе)
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [condition, setCondition] = useState("");
  // Desktop: сворачиваемый sidebar фильтров (>=1024px)
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const collection = params.get("collection") ?? "";

  useEffect(() => { track("catalog_opened", { category }); }, []);
  useEffect(() => {
    api<{ brands: string[] }>("/catalog/brands").then((d) => setBrands(d.brands)).catch(() => {});
  }, []);
  // Круг поиска в нижней навигации ведёт сюда с меткой focus=search: своей
  // страницы у поиска нет, и заводить её ради одной строки означало бы вторую
  // реализацию того, что уже работает в каталоге. Метка снимается сразу после
  // фокуса, чтобы возврат назад по истории не фокусировал строку повторно.
  //
  // Поднимет ли этот фокус клавиатуру — не проверено. Фокус ставится вне
  // пользовательского жеста (внутри useEffect после навигации), а не по
  // прямому тапу в поле, и в Telegram WebView на iOS такие «программные»
  // фокусы нередко НЕ поднимают клавиатуру сами по себе. Проверять на живом
  // телефоне, а не по факту прохождения тестов.
  useEffect(() => {
    if (params.get("focus") !== "search") return;
    searchRef.current?.focus();
    const next = new URLSearchParams(params);
    next.delete("focus");
    setParams(next, { replace: true });
  }, [params, setParams]);

  // Ряд категорий описывает то, что человек сейчас смотрит: с выбранным брендом
  // это категории ВНУТРИ бренда. Раньше ряд был глобальным, и тап по
  // «смартфонам» на витрине Dyson давал brand=Dyson&category=смартфоны — пустой
  // экран в один тап. В кэш кладём только глобальный ответ: брендовый там
  // означал бы, что следующий вход в каталог начнётся с чужого набора.
  useEffect(() => {
    const qs = brand ? `?brand=${encodeURIComponent(brand)}` : "";
    api<{ categories: NavCategory[] }>(`/catalog/categories${qs}`)
      .then((d) => {
        setCats(sanitizeCategories(d.categories));
        if (!brand) saveCachedCategories(d.categories);
      })
      .catch(() => {});
  }, [brand]);

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
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    setCardsError(false);
    setRefreshing(true);
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
    api<{ cards?: TCard[] }>(`/catalog/list?${qs.toString()}`, { signal: controller.signal })
      .then((d) => {
        if (controller.signal.aborted) return;
        startTransition(() => setCards(Array.isArray(d.cards) ? d.cards : []));
      })
      .catch(() => {
        if (!controller.signal.aborted) setCardsError(true);
      })
      .finally(() => {
        if (catalogRequest.current === controller) setRefreshing(false);
      });
  }, [category, sort, priceMax, urlQuery, brand, onlyStock, onlyToday, condition, collection]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => {
    catalogRequest.current?.abort();
    catalogRequest.current = null;
  }, []);

  function pickCategory(key: string) {
    setCategory(key);
    const next = new URLSearchParams(params);
    if (key) next.set("category", key); else next.delete("category");
    setParams(next);
  }

  /** Выбрать или снять бренд.
   *
   *  Бренд живёт в URL, а не только в стейте: витрина бренда — это адрес,
   *  которым делятся и на который ведут плитки главной.
   *
   *  Смена бренда СБРАСЫВАЕТ категорию: у другого бренда другой ассортимент, и
   *  «красота» от Dyson у Apple не существует — сохранённая категория дала бы
   *  пустой экран. Снятие бренда категорию оставляет: это расширение выборки,
   *  и раздел, в котором человек стоит, существует и без бренда.
   */
  function pickBrand(value: string) {
    setBrand(value);
    const next = new URLSearchParams(params);
    if (value) {
      next.set("brand", value);
      if (value !== brand) { next.delete("category"); setCategory(""); }
    } else {
      next.delete("brand");
    }
    setParams(next);
  }

  // Свёрнутое в шторку состояние собираем в один объект: подпись кнопки,
  // счётчик и сама шторка обязаны читать одно и то же, иначе кнопка начнёт
  // врать о том, что применено.
  const filters: CatalogFilters = { onlyStock, onlyToday, brand, priceMax };
  const filterCount = activeFilterCount(filters);

  function applyFilters(patch: Partial<CatalogFilters>) {
    if (patch.onlyStock !== undefined) setOnlyStock(patch.onlyStock);
    if (patch.onlyToday !== undefined) setOnlyToday(patch.onlyToday);
    // Бренд идёт через pickBrand, а не setBrand: он живёт в URL и сбрасывает
    // категорию — правило одно на все места, где бренд можно сменить.
    if (patch.brand !== undefined) pickBrand(patch.brand);
    if (patch.priceMax !== undefined) setPriceMax(patch.priceMax);
  }

  function resetFilters() {
    setOnlyStock(false);
    setOnlyToday(false);
    setPriceMax("");
    pickBrand("");
  }

  // Рамка есть у обоих состояний (у активного — в цвет фона), поэтому высота
  // одинаковая. На mobile рамка неактивного прозрачна — вид не меняется.
  const chip = (active: boolean) =>
    `tap shrink-0 rounded-full border px-3.5 py-2 text-xs font-medium transition-colors ${
      active ? "border-accent bg-accent text-white" : "border-transparent bg-surface text-text shadow-soft lg:border-border"
    }`;

  // Заголовок раздела и счётчик — из фактического ответа API, без хардкода.
  // Заголовок называет то, что человек видит. С брендом это витрина бренда
  // («Dyson», «Dyson · Красота»), иначе — раздел каталога.
  const categoryLabel = category ? tabs.find((c) => c.key === category)?.label : undefined;
  const sectionTitle = brand
    ? [brand, categoryLabel].filter(Boolean).join(" · ")
    : categoryLabel ?? "Каталог";
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
      <h1 className="text-2xl font-bold lg:hidden">{sectionTitle}</h1>

      {/* Desktop: сетка [sidebar фильтров | контент]; sidebar сворачивается.
          lg:mt-0 — отступ от шапки задаёт padding-top у <main> (lg:pt-6 = 24px),
          иначе к нему прибавлялся ещё mt-4 и разрыв уходил за 32px. */}
      <div className={`lg:mt-0 lg:grid lg:items-start lg:gap-8 ${sidebarOpen ? "lg:grid-cols-[260px_minmax(0,1fr)]" : ""}`}>
        {sidebarOpen && (
          <FilterSidebar
            category={category} onCategory={pickCategory} tabs={tabs}
            brands={brands} brand={brand} onBrand={pickBrand}
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
          лишь создавала наложение на карточки.

          Панель уезжает при прокрутке вниз и возвращается при прокрутке вверх
          (toolbar-hide + useHideOnScroll): три ряда инструментов — четверть
          экрана, и пока человек листает товар, экран нужен товару. Прячется
          transform'ом, место в потоке остаётся за ней, поэтому карточки не
          прыгают. */}
      <div
        ref={hideToolbarRef}
        className="seam-guard toolbar-hide sticky -top-3 z-20 -mx-4 space-y-2 border-b border-border bg-bg px-4 pb-2.5 pt-2 lg:static lg:top-auto lg:mx-0 lg:border-0 lg:px-0 lg:pb-0 lg:pt-0"
      >
        <div className="flex items-center gap-2">
        {/* Поиск каталога — ТОЛЬКО mobile/tablet. На desktop единственный поиск —
            в шапке (DesktopHeader), пишет в тот же URL-параметр `query`. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl2 bg-surface px-4 shadow-soft lg:hidden">
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={searchRef}
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по каталогу"
            aria-label="Поиск по каталогу"
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
                e.currentTarget.blur(); // спрятать клавиатуру — результаты уже на экране
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="Очистить поиск"
              className="tap -mr-2 flex h-11 w-11 shrink-0 items-center justify-center text-muted">
              <Icon name="close" className="h-4 w-4" strokeWidth={2} />
            </button>
          )}
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

        {/* Недавние запросы при пустом фокусе поиска (история из localStorage).
            onMouseDown + preventDefault: тап по чипу не блюрит инпут, значение
            подставляется до закрытия ряда. */}
        {searchFocused && !q.trim() && recentQueries.length > 0 && (
          <div ref={enterRefCallback("fade")} className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 lg:hidden">
            <span className="shrink-0 text-[11px] font-medium text-muted">Вы искали:</span>
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

        {/* Чип бренда стоит ПЕРЕД рядом категорий и снимается одним тапом.
            Без него сужение выдачи выглядит как поломка каталога: товаров мало,
            причина не названа, выхода не видно. Ряд справа — категории этого же
            бренда, поэтому пустых пересечений в один тап больше нет. */}
        <div className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 lg:hidden">
          {brand && (
            <button
              onClick={() => pickBrand("")}
              aria-label={`Показать весь каталог, убрать бренд ${brand}`}
              className="tap flex shrink-0 items-center gap-1.5 rounded-full border border-accent bg-accent px-3.5 py-2 text-xs font-semibold text-white"
            >
              {brand}
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor"
                strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          )}
          {tabs.map((c) => (
            <button key={c.key} onClick={() => pickCategory(c.key)} className={chip(category === c.key)}>
              {c.label}
            </button>
          ))}
        </div>

        {/* Управление выдачей (mobile/tablet) — две кнопки вместо прежнего ряда
            из семи элементов. Тот ряд занимал примерно треть первого экрана и
            всем весом спорил с товаром, ради которого сюда заходят; всё, что в
            нём было, переехало в шторки (components/CatalogFilterSheet).

            Кнопки НЕ прокручиваются и не растягиваются: их всего две, и
            горизонтальная лента из двух элементов — это лента, которую некуда
            листать. Ряд остаётся в том же sticky-блоке, что поиск и категории. */}
        <div className="flex items-center gap-2 lg:hidden">
          <button
            onClick={() => setSheet("sort")}
            aria-haspopup="dialog"
            className="tap flex shrink-0 items-center gap-1 rounded-field border border-border bg-surface px-3 py-2 text-xs font-medium text-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {sortButtonLabel(SORTS, sort)}
            <Icon name="chevron-down" className="h-3.5 w-3.5 text-muted" strokeWidth={2.2} />
          </button>
          <button
            onClick={() => setSheet("filters")}
            aria-haspopup="dialog"
            // Активные фильтры помечены цветом рамки и текста, а не заливкой:
            // залитая кнопка снова стала бы самым тяжёлым объектом экрана.
            // Молчащий свёрнутый фильтр читается как «каталог сломался,
            // товаров мало» — счётчик в подписи и есть то, что об этом говорит.
            className={`tap shrink-0 rounded-field border px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              filterCount > 0
                ? "border-accent bg-accent/5 text-accent"
                : "border-border bg-surface text-text"
            }`}
          >
            {filterButtonLabel(filters)}
          </button>
        </div>
      </div>

      {refreshing && cards !== null && (
        <div className="loading-bar mt-3 h-0.5 rounded-full" role="progressbar" aria-label="Обновляем товары" />
      )}
      {cardsError && cards !== null && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-field bg-[#fff3f2] px-3 py-2 text-xs text-[#b42318]" role="alert">
          <span>Не удалось обновить выдачу — показаны предыдущие товары.</span>
          <button onClick={load} className="tap shrink-0 font-semibold">Повторить</button>
        </div>
      )}

      {/* Сетка товаров: 2 / 3 (tablet) / 4 (desktop) / 5 (wide) */}
      {cardsError && cards === null ? (
        <div className="mt-6"><ErrorState message="Не удалось загрузить товары" onRetry={load} /></div>
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
        <div
          className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:mt-5 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5"
          aria-busy={refreshing}
        >
          {cards.map((c) => <ProductCard key={c.id} card={c} />)}
        </div>
      )}

        </div>{/* /контент */}
      </div>{/* /desktop grid */}

      {sheet === "sort" && (
        <CatalogSortSheet
          sorts={SORTS}
          value={sort}
          onPick={setSort}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "filters" && (
        <CatalogFilterSheet
          value={filters}
          brands={brands}
          onChange={applyFilters}
          onReset={resetFilters}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

/** Пустая выдача каталога — не тупик: запрос сохранён в строке поиска, можно
 *  изменить формулировку, спросить AI (с prefill) или сбросить фильтры. */
function NoResults({ query, onAskAi, onReset }: {
  query: string; onAskAi: () => void; onReset: () => void;
}) {
  return (
    <div ref={enterRefCallback("fade")} className="mt-6 rounded-xl2 bg-surface p-6 text-center shadow-soft">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mutedbg text-muted">
        <Icon name="search" className="h-7 w-7" strokeWidth={1.6} />
      </div>
      <p className="mt-2 text-[15px] font-bold">
        {query ? <>По запросу «{query}» ничего не нашлось</> : "Ничего не найдено"}
      </p>
      <p className="mx-auto mt-1 max-w-xs text-[13px] text-muted">
        Попробуйте изменить формулировку или фильтры — либо опишите задачу AI, он ищет по смыслу.
      </p>
      <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2">
        <button onClick={onAskAi}
          className="tap flex items-center justify-center gap-1.5 rounded-field bg-accent px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-accentdark">
          <Icon name="sparkles" className="h-4 w-4" strokeWidth={2} />
          Спросить AI{query ? ` «${query.length > 24 ? `${query.slice(0, 24)}…` : query}»` : ""}
        </button>
        <button onClick={onReset}
          className="tap rounded-field bg-mutedbg px-4 py-2.5 text-[13px] font-semibold text-text">
          Сбросить фильтры
        </button>
      </div>
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
  category, onCategory, tabs, brands, brand, onBrand, priceMax, onPriceMax,
  onlyStock, onOnlyStock, onlyToday, onOnlyToday, condition, onCondition,
}: {
  category: string; onCategory: (k: string) => void;
  /** Вкладки категорий приходят сверху: список строится из каталога,
   *  а не из константы — своего источника у сайдбара быть не должно. */
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
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Категория</p>
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
            className="h-4 w-4 accent-[rgb(var(--app-accent))]" />
          В наличии
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl px-1 py-1.5 text-sm">
          <input type="checkbox" checked={onlyToday} onChange={(e) => onOnlyToday(e.target.checked)}
            className="h-4 w-4 accent-[rgb(var(--app-accent))]" />
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
