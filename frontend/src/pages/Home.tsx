import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track, trackProduct } from "../lib/analytics";
import { useAuthStore } from "../store/auth";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";
import { ScenarioRequestSheet, ScenarioChoiceSheet } from "../components/ScenarioSheet";
import { MACBOOK_CHOICES, type ChoiceItem, type ScenarioKey } from "../lib/scenario";
import { usePublicConfig } from "../lib/appConfig";
import { openExternalLink } from "../lib/telegram";
import { ProfileChip } from "../components/ProfileChip";
import { ErrorState } from "../components/StateViews";
import SearchPanel from "../components/SearchPanel";
import { pushSearchQuery } from "../lib/searchHistory";
import { actionRoute, safeExternalUrl, safeInternalRoute } from "../lib/route";
import { loadCachedCategories, saveCachedCategories } from "../lib/categoryCache";

type Category = { key: string; label: string; icon: string; count: number };
type Feed = { hot: TCard[]; available_today: TCard[]; new: TCard[]; recommended: TCard[] };

/** Управляемая главная (v4): баннеры и кнопки категорий приходят из /api/home. */
type HomeBanner = {
  id: number; title: string; subtitle?: string | null; emoji?: string | null;
  image_url?: string | null; background_gradient?: string | null;
  action_type: string; action_value?: string | null;
};
type HomeCat = {
  id: number; title: string; emoji?: string | null; icon_url?: string | null;
  background_gradient?: string | null; action_type: string; action_value?: string | null;
};
type HomeData = { banners: HomeBanner[]; categories: HomeCat[] };


/** Запасные промо-блоки, если /api/home недоступен (backend старой версии). */
const FALLBACK_PROMOS: HomeBanner[] = [
  { id: -1, emoji: "🔥", title: "Горячие предложения", subtitle: "Лучшие цены этой недели", background_gradient: "linear-gradient(135deg,#f43f5e,#d97706)", action_type: "category", action_value: "__sale__" },
  { id: -2, emoji: "⚡", title: "Забрать сегодня", subtitle: "В наличии на Горбушке", background_gradient: "linear-gradient(135deg,#0e9f6e,#0694a2)", action_type: "collection", action_value: "today" },
  { id: -3, emoji: "🤖", title: "Подберём технику", subtitle: "Расскажите AI, что нужно", background_gradient: "linear-gradient(135deg,#1a7fd4,#6d5ae0)", action_type: "ai", action_value: "" },
];

// Захардкоженного списка категорий здесь больше нет: он разъезжался с базой и
// показывал плитки, которых в каталоге не существует. Мгновенная отрисовка до
// ответа /api идёт из кэша последнего реального ответа (см. lib/categoryCache).

export default function Home() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const config = usePublicConfig();
  // v5.4.0: встроенные сценарные заявки (Trade-In/бизнес/опт) и меню MacBook.
  const [scenario, setScenario] = useState<ScenarioKey | null>(null);
  const [macbookOpen, setMacbookOpen] = useState(false);
  // Контакт обязателен, только если менеджеру некуда ответить в Telegram
  // (у пользователя нет @username) — тогда просим телефон.
  const requirePhone = !user?.username;
  const managerUrlFor = (k: ScenarioKey): string =>
    (k === "trade_in" ? config.manager_tradein_url
      : k === "b2b" ? config.manager_b2b_url
      : config.manager_wholesale_url) || config.manager_retail_url;

  function openScenario(k: ScenarioKey) {
    track("quick_scenario_clicked", { scenario: k });
    setScenario(k);
  }
  function openMacbook() {
    track("quick_scenario_clicked", { scenario: "pick_macbook" });
    setMacbookOpen(true);
  }
  function pickMacbook(item: ChoiceItem) {
    track("scenario_option_selected", { scenario: "macbook", field: item.key });
    setMacbookOpen(false);
    // prefill без авто-отправки: пользователь видит текст и жмёт «Отправить» сам.
    navigate(`/ai?q=${encodeURIComponent(item.prefill)}`);
  }
  // Стартуем с кэша последнего реального ответа — hero-чипы рисуются мгновенно,
  // без сдвига вёрстки и без выдуманных категорий.
  const [categories, setCategories] = useState<Category[]>(() => loadCachedCategories());
  const [home, setHome] = useState<HomeData | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  // Раньше ошибка /catalog/feed молча проглатывалась и feed оставался null
  // навсегда — секции показывали скелетон бесконечно, никогда не сообщая
  // о сбое. Теперь отдельно отличаем «ещё грузится» от «не удалось».
  const [feedError, setFeedError] = useState(false);
  // Доп. секции desktop-главной (Скидки/Apple/Gaming) — те же API каталога
  const [extra, setExtra] = useState<{ sale: TCard[]; apple: TCard[]; gaming: TCard[] } | null>(null);
  const [lead, setLead] = useState<TCard | null>(null);
  // Консультационная заявка без товара (fallback, когда ссылка менеджера пуста)
  const [consult, setConsult] = useState(false);
  const [search, setSearch] = useState("");
  // Панель умного поиска: открыта по фокусу (полезное пустое состояние) или
  // при вводе (live-результаты). Содержимое — SearchPanel; debounce и отмена
  // запросов (AbortController) — в lib/liveSearch.
  const [searchOpen, setSearchOpen] = useState(false);
  // v5.2.6: персональные секции («Для вас», «Недавно смотрели»)
  const [recs, setRecs] = useState<TCard[] | null>(null);
  const [recsMode, setRecsMode] = useState<string>("cold");
  const [recentlyViewed, setRecentlyViewed] = useState<TCard[] | null>(null);

  const loadFeed = useCallback(() => {
    setFeed(null);
    setFeedError(false);
    api<Feed>("/catalog/feed").then(setFeed).catch(() => setFeedError(true));
  }, []);

  useEffect(() => {
    track("app_opened");
    api<HomeData>("/home")
      .then((d) => setHome(d))
      .catch(() => setHome({ banners: FALLBACK_PROMOS, categories: [] }));
    api<{ categories: Category[] }>("/catalog/categories")
      .then((d) => { setCategories(d.categories); saveCachedCategories(d.categories); })
      .catch(() => {});
    loadFeed();
    // Персональные рекомендации и «недавно смотрели» (v5.2.6)
    api<{ cards?: TCard[]; mode?: string }>("/catalog/recommendations?limit=12")
      .then((d) => { setRecs(d.cards ?? []); setRecsMode(d.mode ?? "cold"); })
      .catch(() => setRecs([]));
    api<{ cards?: TCard[] }>("/catalog/recently-viewed?limit=10")
      .then((d) => setRecentlyViewed(d.cards ?? []))
      .catch(() => setRecentlyViewed([]));
    // Секции desktop-главной; ошибки не критичны — секция просто не показывается
    Promise.all([
      api<{ cards?: TCard[] }>("/catalog/list?category=__sale__&sort=popularity").then((d) => d.cards ?? []).catch(() => []),
      api<{ cards?: TCard[] }>("/catalog/list?brand=Apple&sort=popularity").then((d) => d.cards ?? []).catch(() => []),
      api<{ cards?: TCard[] }>(`/catalog/list?category=${encodeURIComponent("консоли")}&sort=popularity`).then((d) => d.cards ?? []).catch(() => []),
    ]).then(([sale, apple, gaming]) => setExtra({ sale, apple, gaming }));
  }, [loadFeed]);

  function goSearch() {
    const q = search.trim();
    if (q) {
      pushSearchQuery(q);
      track("search_query_submitted", { query_length: q.length, source: "home_enter" });
    }
    navigate(q ? `/catalog?query=${encodeURIComponent(q)}` : "/catalog");
  }

  /** Навигация из поисковой панели: сохранить осмысленный запрос в историю и уйти. */
  function panelNavigate(to: string) {
    const q = search.trim();
    if (q.length >= 2) pushSearchQuery(q);
    setSearch("");
    setSearchOpen(false);
    navigate(to);
  }

  // Чипы категорий hero: приоритет админских категорий → каталог → фолбэк
  // (та же логика, что была у прежней сетки категорий), максимум 6.
  const heroChips: { key: string; label: string; route: string }[] = (
    home && home.categories.length > 0
      ? home.categories.map((c) => ({
          key: String(c.id),
          label: c.title,
          route: actionRoute(c.action_type, c.action_value),
        }))
      : categories.map((c) => ({
          key: c.key,
          label: c.label,
          route: `/catalog?category=${encodeURIComponent(c.key)}`,
        }))
  ).slice(0, 6);

  // Дедуп соседних персональных секций: «Для вас» не повторяет «Недавно
  // смотрели» (если та показана), а «Вам также может понравиться» — обе.
  const recentShown = recentlyViewed && recentlyViewed.length >= 2 ? recentlyViewed : [];
  const recentIds = new Set(recentShown.map((c) => c.id));
  const forYou = (recs ?? []).filter((c) => !recentIds.has(c.id));
  const forYouIds = new Set(forYou.map((c) => c.id));
  const alsoLike = (feed?.recommended ?? []).filter((c) => !forYouIds.has(c.id) && !recentIds.has(c.id));

  return (
    <div className="mx-auto max-w-md lg:max-w-none">
      {/* ===== Единый верх: системная область Telegram + hero одного цвета. Тёмную
          подложку выреза статус-бара даёт глобальный .hero-top-inset в Layout (на
          всех экранах); здесь только сам hero. ===== */}
      <header className="app-hero -mx-4 -mt-3 rounded-b-hero px-4 pb-6 pt-4 text-white shadow-float lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[18px] font-bold leading-6 tracking-tight">AI Seller</p>
            <p className="mt-0.5 truncate text-[12px] font-medium text-white/70">Техника, которую легко найти</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => navigate("/favorites")}
              aria-label="Избранное"
              className="tap flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.12] backdrop-blur"
            >
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20.7 4.3 13a4.6 4.6 0 0 1 0-6.5 4.6 4.6 0 0 1 6.5 0l1.2 1.2 1.2-1.2a4.6 4.6 0 0 1 6.5 0 4.6 4.6 0 0 1 0 6.5z" />
              </svg>
            </button>
            <ProfileChip user={user} variant="mobile" />
          </div>
        </div>

        {/* Крупный поиск — главный элемент верха (relative: под ним панель подсказок).
            onBlur на обёртке: закрываем панель, только если фокус ушёл наружу
            (кнопки панели держат фокус через preventDefault на mousedown). */}
        <div
          className="relative mt-4 flex gap-2"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSearchOpen(false);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-card bg-white px-4 text-text shadow-[0_4px_14px_-6px_rgba(9,23,41,0.28)]">
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => {
                if (!searchOpen) track("search_focused", { source: "home" });
                setSearchOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") goSearch();
                if (e.key === "Escape") { setSearchOpen(false); e.currentTarget.blur(); }
              }}
              placeholder="Найти iPhone, MacBook, AirPods…"
              aria-label="Поиск по каталогу"
              aria-expanded={searchOpen || search.trim().length >= 2}
              className="h-12 min-w-0 flex-1 bg-transparent text-[15px] font-medium outline-none placeholder:font-normal placeholder:text-muted"
            />
            {/* Кнопка очистки — только когда есть текст. Иконка сканера убрана до
                реализации сценария «наведи камеру → AI определил модель». */}
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Очистить поиск"
                className="tap -mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-mutedbg"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            )}
          </div>
          <button
            onClick={() => navigate("/ai")}
            aria-label="AI-подбор"
            className="tap flex shrink-0 items-center gap-1 rounded-card bg-white/15 px-4 text-[13px] font-bold text-white ring-1 ring-inset ring-white/15 backdrop-blur transition-colors hover:bg-white/20"
          >
            ✨ AI
          </button>

          {/* Умная поисковая панель: по фокусу — история/чипы/недавние/AI,
              при вводе — live-результаты (debounce + AbortController внутри).
              mousedown preventDefault: тап по панели не блюрит инпут, клик доходит. */}
          {(searchOpen || search.trim().length >= 2) && (
            <div
              onMouseDown={(e) => e.preventDefault()}
              className="fade-in absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-xl2 bg-white text-text shadow-sheet"
            >
              <SearchPanel
                query={search}
                onNavigate={panelNavigate}
                onPickQuery={(q) => setSearch(q)}
                chips={heroChips}
                recentlyViewed={recentlyViewed}
              />
            </div>
          )}
        </div>

        {/* Быстрые категории — светлые чипы на тёмном hero (сразу видно глубину
            каталога). Данные: админские категории → каталог → фолбэк; максимум 6. */}
        <div className="no-scrollbar -mx-4 mt-4 flex gap-2 overflow-x-auto px-4">
          {heroChips.map((c) => (
            <button
              key={c.key}
              onClick={() => navigate(safeInternalRoute(c.route))}
              className="tap shrink-0 whitespace-nowrap rounded-full bg-white/[0.13] px-4 py-2 text-[13px] font-semibold text-[color:var(--app-hero-chip-ink)] transition-colors hover:bg-white/20"
            >
              {c.label}
            </button>
          ))}
          <button
            onClick={() => navigate("/catalog")}
            className="tap shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-semibold text-white/90 ring-1 ring-inset ring-white/25 transition-colors hover:bg-white/10"
          >
            Все категории →
          </button>
        </div>
      </header>

      {/* ===== Быстрые сценарии (mobile): не категории, а намерения пользователя.
          Товарные ведут в каталог, консультационные — к профильному менеджеру из
          public config (пустая ссылка → существующий fallback: AI-консультант).
          На desktop аналогичные действия уже есть в сайдбаре — не дублируем. ===== */}
      <QuickScenarios
        onCatalog={(route, scenarioKey) => {
          track("quick_scenario_clicked", { scenario: scenarioKey });
          navigate(safeInternalRoute(route));
        }}
        onScenario={openScenario}
        onMacbook={openMacbook}
      />

      {/* ===== Desktop: сетка [sidebar 260px | контент] ===== */}
      <div className="lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-8">
        <HomeSidebar
          categories={categories}
          homeCats={home?.categories ?? []}
          onCategory={(route) => navigate(safeInternalRoute(route))}
          onScenario={openScenario}
          onManager={() => { if (!openExternalLink(config.manager_retail_url)) navigate("/ai"); }}
        />

        <div className="min-w-0">
      {/* ===== Hero-баннеры (управляются из админки): mobile — лента, desktop — сетка 3 ===== */}
      <div className="no-scrollbar -mx-4 mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 lg:mx-0 lg:mt-0 lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible lg:px-0 lg:pb-0">
        {(home ? home.banners : Array.from({ length: 2 }, () => null)).map((b, i) =>
          b ? (
            <button
              key={b.id}
              onClick={() => {
                if (b.action_type === "external" && b.action_value) {
                  // только http/https: `javascript:`/`data:` из админки не исполняем
                  const ext = safeExternalUrl(b.action_value);
                  if (ext) window.open(ext, "_blank", "noopener,noreferrer");
                  return;
                }
                navigate(safeInternalRoute(actionRoute(b.action_type, b.action_value)));
              }}
              className="tap lift relative h-[152px] w-[300px] shrink-0 snap-start overflow-hidden rounded-hero p-5 text-left text-white shadow-float transition-shadow lg:h-[176px] lg:w-auto lg:hover:shadow-[0_18px_40px_-14px_rgba(17,24,39,0.32)]"
              style={{ background: b.background_gradient || "linear-gradient(135deg,#1a7fd4,#6d5ae0)" }}
            >
              {b.image_url && (
                <img src={b.image_url} alt="" loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover" />
              )}
              <div className="relative z-10 flex h-full flex-col justify-between">
                <span className="text-3xl drop-shadow">{b.emoji}</span>
                <div>
                  <p className="text-[17px] font-bold leading-6 drop-shadow">{b.title}</p>
                  {b.subtitle && <p className="mt-1 text-[13px] font-medium text-white/85 drop-shadow">{b.subtitle}</p>}
                </div>
              </div>
              {b.image_url && <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />}
            </button>
          ) : (
            <div key={i} className="skeleton h-[152px] w-[300px] shrink-0 rounded-hero lg:h-[176px] lg:w-auto" />
          ),
        )}
      </div>

      {/* ===== Секции товаров: mobile — ленты/сетка 2, desktop — сетка 4 (5 на wide) =====
          Все три секции ниже (Хиты/Сегодня/Рекомендуем) читают один и тот же /catalog/feed —
          при его сбое раньше секции бесконечно показывали скелетон (feed оставался null
          навсегда). Теперь при ошибке — один явный блок с повтором вместо трёх немых. */}

      {/* v5.2.6: персональные секции — «Недавно смотрели» (если есть история) и «Для вас» */}
      {recentlyViewed && recentlyViewed.length >= 2 && (
        <Section title="Вы недавно смотрели" cards={recentlyViewed} onLead={setLead}
          onAll={() => navigate("/catalog")} />
      )}
      <Section
        title="Для вас"
        subtitle={recsMode === "cold" ? "Популярное и новое из разных категорий" : "Подобрали по вашим просмотрам"}
        cards={recs === null ? undefined : forYou}
        onLead={setLead}
        onAll={() => navigate("/catalog")}
        onOpen={(c) => trackProduct("recommendation_click", { product_id: c.id, source: "for_you" })}
        grid
      />

      {/* Единственный AI-консьерж CTA между товарными секциями (не плодим их) */}
      <button
        onClick={() => { track("search_ai_escalated", { source: "home_concierge" }); navigate("/ai"); }}
        className="tap mt-6 flex w-full items-center gap-3.5 rounded-xl2 bg-surface p-4 text-left shadow-card"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-bold leading-5">Не уверены, что выбрать?</span>
          <span className="mt-0.5 block text-[12px] leading-4 text-muted">
            Ответьте на несколько вопросов — AI подберёт варианты из реального наличия
          </span>
        </span>
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>

      {feedError ? (
        <div className="mt-6"><ErrorState message="Не удалось загрузить подборки товаров" onRetry={loadFeed} /></div>
      ) : (
        <>
          <Section title="Хиты продаж" cards={feed?.hot} onLead={setLead}
            onAll={() => navigate("/catalog")} />
          <Section title="Забрать сегодня" cards={feed?.available_today} onLead={setLead}
            onAll={() => navigate("/catalog?today=1")} />
          <Section title="Новинки" cards={feed?.new} onLead={setLead}
            onAll={() => navigate("/catalog")} />
        </>
      )}

      {/* Desktop-секции (Скидки/Apple/Gaming) — только lg+, mobile-страницу не удлиняем */}
      <div className="hidden lg:block">
        <Section title="Скидки" cards={extra?.sale} onLead={setLead}
          onAll={() => navigate("/catalog?category=__sale__")} grid />
        <Section title="Apple" cards={extra?.apple} onLead={setLead}
          onAll={() => navigate("/catalog")} grid />
        <Section title="Gaming" cards={extra?.gaming} onLead={setLead}
          onAll={() => navigate(`/catalog?category=${encodeURIComponent("консоли")}`)} grid />
      </div>

      {!feedError && alsoLike.length >= 3 && (
        <Section title="Вам также может понравиться" cards={alsoLike} onLead={setLead}
          onAll={() => navigate("/catalog")} grid />
      )}

      {/* Явный вход в полный каталог (mobile): главная ощущается как магазин с продолжением */}
      <button
        onClick={() => navigate("/catalog")}
        className="tap mt-6 flex w-full items-center justify-center gap-1.5 rounded-xl2 bg-surface py-3.5 text-sm font-semibold text-accent shadow-soft lg:hidden"
      >
        Открыть весь каталог →
      </button>

      {/* Финальный CTA: не нашли модель — оставить заявку внутри приложения.
          Всегда открывает встроенную форму LeadForm (source=manager) — заявка
          попадает в «Заявки» и в админку; переход в Telegram — только вторичным
          действием после успешной отправки, не первичным. */}
      <div className="mt-4 rounded-xl2 bg-surface p-4 text-center shadow-soft lg:mt-8">
        <p className="text-[15px] font-bold">Не нашли нужную модель?</p>
        <p className="mx-auto mt-1 max-w-xs text-[13px] text-muted">
          Оставьте заявку — уточним наличие и привезём под заказ.
        </p>
        <button
          onClick={() => {
            track("empty_state_action_clicked", { source: "home_footer_manager" });
            setConsult(true);
          }}
          className="tap mt-3 rounded-field bg-mutedbg px-5 py-2.5 text-[13px] font-semibold text-text transition-colors hover:bg-accent hover:text-white"
        >
          💬 Оставить заявку
        </button>
      </div>

        </div>{/* /контент */}
      </div>{/* /desktop grid */}

      {lead && (
        <LeadForm
          productId={lead.id} productTitle={lead.title} productPrice={lead.price}
          source="home" onClose={() => setLead(null)}
        />
      )}
      {consult && (
        <LeadForm
          productId={null} productTitle={null} productPrice={null}
          source="manager" presetMessage="Ищу модель, которой нет в каталоге"
          onClose={() => setConsult(false)}
        />
      )}

      {/* v5.4.0: встроенные сценарные заявки (Trade-In / Для бизнеса / Опт) */}
      {scenario && (
        <ScenarioRequestSheet
          scenario={scenario}
          managerUrl={managerUrlFor(scenario)}
          requirePhone={requirePhone}
          onClose={() => setScenario(null)}
        />
      )}
      {/* v5.4.0: меню «Подобрать MacBook» (AI prefill, без заявки и авто-отправки) */}
      {macbookOpen && (
        <ScenarioChoiceSheet
          title="Какой MacBook вам нужен?"
          items={MACBOOK_CHOICES}
          onClose={() => setMacbookOpen(false)}
          onPick={pickMacbook}
        />
      )}
    </div>
  );
}

function Section({
  title, subtitle, cards, onLead, onAll, grid, onOpen,
}: {
  title: string; subtitle?: string; cards?: TCard[]; onLead: (c: TCard) => void;
  onAll: () => void; grid?: boolean; onOpen?: (c: TCard) => void;
}) {
  if (!cards) return <SectionSkeleton title={title} />;
  if (cards.length === 0) return null;
  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-bold leading-5">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        <button onClick={onAll} className="shrink-0 text-xs font-medium text-accent">Смотреть все</button>
      </div>
      {grid ? (
        // mobile 2 кол -> tablet 3 -> desktop 4 -> wide 5
        <div className="stagger mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {cards.map((c) => <ProductCard key={c.id} card={c} onLead={onLead} onOpen={onOpen} />)}
        </div>
      ) : (
        // mobile — горизонтальная лента, desktop — та же сетка 4/5
        <div className="no-scrollbar stagger -mx-4 mt-3 flex gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:gap-4 lg:overflow-visible lg:px-0 lg:pb-0 wide:grid-cols-5">
          {cards.map((c) => <ProductCard key={c.id} card={c} onLead={onLead} onOpen={onOpen} compact />)}
        </div>
      )}
    </div>
  );
}

/** Desktop-sidebar главной: категории + быстрые действия (Опт/B2B/Trade-In/менеджер).
 *  Данные те же, что и в mobile-версии; бизнес-логики нет. */
function HomeSidebar({
  categories, homeCats, onCategory, onScenario, onManager,
}: {
  categories: Category[];
  homeCats: HomeCat[];
  onCategory: (route: string) => void;
  onScenario: (k: ScenarioKey) => void;
  onManager: () => void;
}) {
  const cats: { key: string; label: string; icon: string; route: string }[] =
    homeCats.length > 0
      ? homeCats.map((c) => ({
          key: String(c.id), label: c.title, icon: c.emoji || "🛍️",
          route: actionRoute(c.action_type, c.action_value),
        }))
      : categories.map((c) => ({
          key: c.key, label: c.label, icon: c.icon,
          route: `/catalog?category=${encodeURIComponent(c.key)}`,
        }));

  // Опт/бизнес/Trade-In открывают встроенную сценарную заявку; «Написать
  // менеджеру» — прямой Telegram (fallback внутри onManager).
  const actions: { icon: string; label: string; sub: string; onClick: () => void }[] = [
    { icon: "📦", label: "Опт", sub: "Партии от 5 шт", onClick: () => onScenario("wholesale") },
    { icon: "🏢", label: "Поставка для компании", sub: "Документы для юрлиц", onClick: () => onScenario("b2b") },
    { icon: "🔄", label: "Trade-In", sub: "Обмен и выкуп техники", onClick: () => onScenario("trade_in") },
    { icon: "💬", label: "Написать менеджеру", sub: "Ответим быстро", onClick: onManager },
  ];

  return (
    <aside className="hidden lg:block">
      <div className="rounded-xl2 bg-surface p-2 shadow-soft">
        <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Категории</p>
        {(cats.length ? cats : [{ key: "_", label: "Каталог", icon: "🛍️", route: "/catalog" }]).map((c) => (
          <button
            key={c.key}
            onClick={() => onCategory(c.route)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-mutedbg"
          >
            <span className="text-lg">{c.icon}</span>
            <span className="min-w-0 truncate">{c.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-xl2 bg-surface p-2 shadow-soft">
        <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Быстрые действия</p>
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={a.onClick}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-mutedbg"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-mutedbg text-lg">{a.icon}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{a.label}</span>
              <span className="block truncate text-xs text-muted">{a.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

/** Иконки быстрых сценариев: спокойные stroke-SVG в стиле BottomNav, не emoji. */
function ScenarioIcon({ name }: { name: string }) {
  const glyph = (() => {
    switch (name) {
      case "iphone":
        return <><rect x="8" y="3" width="8" height="18" rx="2.2" /><path d="M11 18.5h2" /></>;
      case "macbook":
        return <><rect x="5" y="5" width="14" height="9" rx="1" /><path d="M3 17.5h18l-1.4 2.2H4.4z" /></>;
      case "tradein":
        return <><path d="M4 9a8 8 0 0 1 14-3l2 2" /><path d="M20 3v5h-5" /><path d="M20 15a8 8 0 0 1-14 3l-2-2" /><path d="M4 21v-5h5" /></>;
      case "b2b":
        return <><rect x="3.5" y="7.5" width="17" height="12" rx="2" /><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 12.5h17" /></>;
      case "wholesale":
        return <><path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>;
      default: // нейтральный силуэт для незнакомого сценария
        return <><path d="M9.5 3v4.5M14.5 3v4.5" /><rect x="7.5" y="7.5" width="9" height="6" rx="2" /><path d="M12 13.5V18a3 3 0 0 1-3 3" /></>;
    }
  })();
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {glyph}
    </svg>
  );
}

/** Быстрые сценарии на главной (mobile): намерения, а не категории.
 *  Товарные → каталог; «Подобрать MacBook» → AI с prefill (без авто-отправки);
 *  Trade-In/бизнес/опт → профильный менеджер из public config (fallback → AI). */
function QuickScenarios({
  onCatalog, onScenario, onMacbook,
}: {
  onCatalog: (route: string, scenario: string) => void;
  onScenario: (k: ScenarioKey) => void;
  onMacbook: () => void;
}) {
  // Товарные (iPhone/аксессуары) — прямой каталог; MacBook — меню выбора (AI);
  // Trade-In/бизнес/опт — встроенная сценарная заявка (bottom sheet), НЕ менеджер.
  const items: { key: string; label: string; sub: string; onClick: () => void }[] = [
    { key: "iphone", label: "Купить iPhone", sub: "Все модели", onClick: () => onCatalog("/catalog?query=iPhone", "buy_iphone") },
    { key: "macbook", label: "Подобрать MacBook", sub: "Поможем выбрать", onClick: onMacbook },
    { key: "tradein", label: "Trade-In", sub: "Обмен и выкуп", onClick: () => onScenario("trade_in") },
    { key: "b2b", label: "Для бизнеса", sub: "Поставки юрлицам", onClick: () => onScenario("b2b") },
    { key: "wholesale", label: "Опт", sub: "Партии от 5 шт", onClick: () => onScenario("wholesale") },
    // Плитки «Аксессуары» здесь больше нет: она вела в категорию «аксессуары»,
    // которой в каталоге не существует (кабелей/чехлов/зарядок нет вовсе).
    // Реальные категории показывает блок категорий — он строится из данных.
  ];
  return (
    <div className="stagger mt-4 grid grid-cols-2 gap-2 lg:hidden">
      {items.map((s) => (
        <button
          key={s.key}
          onClick={s.onClick}
          className="card-appear tap flex items-center gap-2.5 rounded-xl2 bg-surface px-3 py-2.5 text-left shadow-card"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field bg-mutedbg text-accent">
            <ScenarioIcon name={s.key} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold leading-4">{s.label}</span>
            <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted">{s.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function SectionSkeleton({ title }: { title: string }) {
  return (
    <div className="mt-6">
      <h2 className="text-[17px] font-bold">{title}</h2>
      <div className="no-scrollbar -mx-4 mt-3 flex gap-3 overflow-x-auto px-4 pb-2">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-64 w-40 shrink-0 rounded-xl2" />)}
      </div>
    </div>
  );
}
