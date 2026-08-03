import { useCallback, useEffect, useRef, useState } from "react";
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
import { SegmentedToggle } from "../components/SegmentedToggle";
import { navTiles, type NavAxis, type NavChip } from "../lib/navTiles";
import { aiSearchRoute, catalogSearchRoute } from "../lib/searchRoutes";
import { CartGlyph } from "../components/CartBar";
import { useCart } from "../lib/cart";
import { ClaudeMark } from "../components/ClaudeMark";
import { BrandLockup } from "../components/BrandMark";
import { autoplayReady, nextSlideIndex } from "../lib/carousel";
import { FADE_MS, animateOpacity, animateScrollTo, transitionStyle } from "../lib/motion";

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
type HomeData = { banners: HomeBanner[]; categories: HomeCat[]; brands?: HomeCat[] };


/** Запасные промо-блоки, если /api/home недоступен (backend старой версии). */
const FALLBACK_PROMOS: HomeBanner[] = [
  { id: -1, title: "iPhone в наличии", subtitle: "Забирайте сегодня на Горбушке", action_type: "search", action_value: "iphone" },
  { id: -2, title: "MacBook для работы", subtitle: "Подборка под ваши задачи", action_type: "ai", action_value: "MacBook для работы" },
  { id: -3, title: "PlayStation сегодня", subtitle: "PS5 и игры в наличии", action_type: "search", action_value: "playstation" },
  { id: -4, title: "Подберём лучшую цену", subtitle: "Claude сравнит варианты каталога", action_type: "ai", action_value: "" },
  { id: -5, title: "Техника с гарантией", subtitle: "Проверка и гарантия до 24 месяцев", action_type: "collection", action_value: "hot" },
];

type CuratedPromo = {
  src: string;
  eyebrow: string;
  kind: "product" | "claude" | "warranty";
};

/** Локальная art-direction для пяти штатных промо.
 *
 * Тексты, порядок и действия по-прежнему приходят из admin/API. Картинки здесь
 * служат качественным fallback для уже существующих баннеров без image_url:
 * администратор в любой момент может переопределить их своей картинкой.
 */
function curatedPromo(banner: HomeBanner): CuratedPromo | null {
  const value = `${banner.title} ${banner.action_value ?? ""}`.toLocaleLowerCase("ru");
  if (value.includes("iphone")) {
    return { src: "/assets/promos/iphone-studio.webp", eyebrow: "Забрать сегодня", kind: "product" };
  }
  if (value.includes("macbook")) {
    return { src: "/assets/promos/macbook-studio.webp", eyebrow: "Под ваши задачи", kind: "product" };
  }
  if (value.includes("playstation") || value.includes("ps5")) {
    return { src: "/assets/promos/playstation-studio.webp", eyebrow: "Играть сегодня", kind: "product" };
  }
  if (value.includes("гарант")) {
    return { src: "/assets/promos/warranty-studio.webp", eyebrow: "Проверено", kind: "warranty" };
  }
  if (value.includes("лучш") || (banner.action_type === "ai" && !(banner.action_value ?? "").trim())) {
    return { src: "/assets/promos/claude-price-studio.webp", eyebrow: "AI-подбор", kind: "claude" };
  }
  return null;
}

// Захардкоженного списка категорий здесь больше нет: он разъезжался с базой и
// показывал плитки, которых в каталоге не существует. Мгновенная отрисовка до
// ответа /api идёт из кэша последнего реального ответа (см. lib/categoryCache).

/** Медленная автопрокрутка ленты баннеров.
 *
 *  Лента — нативный scroll-snap, поэтому «пролистнуть» = доскроллить до
 *  offsetLeft следующего ребёнка. Позицию НЕ считаем по ширине слайда: ширина
 *  задана как min(82vw, 320px) плюс gap, и любое расхождение накапливалось бы с
 *  каждым шагом.
 *
 *  При «уменьшить движение» лента продолжает меняться, но затуханием вместо
 *  движения (slideTransition): настройка убирает движение, а не жизнь
 *  интерфейса — та же линия, что в index.css. Прыжка без перехода нет ни в
 *  одном режиме: подменённый между морганиями баннер выглядит сбоем, и человек
 *  не понимает, что лента листается сама.
 */
/** Сколько едет лента к следующему баннеру. Заметно медленнее продуктовых
 *  переходов (--motion-standard, 190мс): здесь движение не отвечает на действие
 *  человека, а само привлекает внимание, и резкий рывок читался бы как сбой. */
const BANNER_SLIDE_MS = 620;

function useBannerAutoplay(count: number, intervalMs = 6_000) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lastInteractionAt = useRef(0);
  const cancelScroll = useRef<() => void>(() => {});
  const cancelFade = useRef<() => void>(() => {});

  useEffect(() => {
    const el = ref.current;
    if (!el || count <= 1) return;

    // Жест человека обрывает нашу анимацию: доводить ленту до «своего» баннера
    // под пальцем — это отнимать управление посреди движения.
    const touched = () => {
      lastInteractionAt.current = Date.now();
      cancelScroll.current();
      // Затухание обрываем вместе с движением, но ленту обязательно возвращаем
      // видимой: иначе жест посреди перехода оставил бы её погашенной.
      cancelFade.current();
      el.style.opacity = "1";
    };
    // pointerdown ловит палец и мышь, wheel — трекпад: любой из них означает,
    // что лентой сейчас управляет человек.
    el.addEventListener("pointerdown", touched, { passive: true });
    el.addEventListener("wheel", touched, { passive: true });
    el.addEventListener("touchstart", touched, { passive: true });

    const timer = window.setInterval(() => {
      const strip = ref.current;
      if (!strip) return;
      const scrollable = strip.scrollWidth - strip.clientWidth > 4;   // desktop-сетка не скроллится
      if (!autoplayReady({
        now: Date.now(),
        lastInteractionAt: lastInteractionAt.current,
        visible: document.visibilityState === "visible",
        scrollable,
      })) return;

      const slides = Array.from(strip.children) as HTMLElement[];
      if (slides.length <= 1) return;
      // Текущий слайд — ближайший к левому краю видимой области.
      const current = slides.reduce(
        (best, node, i) =>
          Math.abs(node.offsetLeft - strip.scrollLeft) <
          Math.abs(slides[best].offsetLeft - strip.scrollLeft) ? i : best,
        0,
      );
      const target = slides[nextSlideIndex(current, slides.length)];
      const left = target.offsetLeft - strip.offsetLeft;

      if (transitionStyle() === "move") {
        // Прокрутка своя, а не браузерная: `behavior: smooth` рисует
        // композитор, и в части окружений (WebView, свёрнутое окно) он молча
        // не срабатывает — лента переставляется мгновенно, и выглядит это как
        // «анимация не работает». См. lib/motion.
        cancelScroll.current();
        cancelScroll.current = animateScrollTo(strip, left, BANNER_SLIDE_MS);
        return;
      }

      // Затухание: гасим ленту, переставляем её уже невидимой и проявляем.
      // Скролл между фазами строго мгновенный — сдвиг под затуханием и был бы
      // тем самым движением, которого просит не делать настройка.
      //
      // Обе фазы считаются из JS: на CSS-переходе устройства с выключенной
      // системной анимацией применяли прозрачность мгновенно, и смена баннера
      // выглядела щелчком (ровно то, что было видно на проде).
      cancelFade.current();
      cancelFade.current = animateOpacity(strip, 1, 0, FADE_MS, () => {
        strip.scrollLeft = left;
        cancelFade.current = animateOpacity(strip, 0, 1, FADE_MS);
      });
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
      cancelScroll.current();
      cancelFade.current();
      // Лента могла остаться погашенной, если размонтировали посреди перехода.
      el.style.opacity = "1";
      el.removeEventListener("pointerdown", touched);
      el.removeEventListener("wheel", touched);
      el.removeEventListener("touchstart", touched);
    };
  }, [count, intervalMs]);

  return ref;
}

export default function Home() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const config = usePublicConfig();
  const cart = useCart();
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
  const bannerStrip = useBannerAutoplay(home?.banners.length ?? 0);
  // Ось навигации общая для hero-чипов и desktop-сайдбара: если развести их по
  // разным состояниям, hero покажет бренды, а сайдбар рядом — категории.
  // Между визитами не сохраняется намеренно: по умолчанию всегда «Категории».
  const [axis, setAxis] = useState<NavAxis>("category");
  const [feed, setFeed] = useState<Feed | null>(null);
  // Раньше ошибка /catalog/feed молча проглатывалась и feed оставался null
  // навсегда — секции показывали скелетон бесконечно, никогда не сообщая
  // о сбое. Теперь отдельно отличаем «ещё грузится» от «не удалось».
  const [feedError, setFeedError] = useState(false);
  // Доп. секции desktop-главной (Скидки/Apple/Gaming) — те же API каталога
  const [extra, setExtra] = useState<{ sale: TCard[]; apple: TCard[]; gaming: TCard[] } | null>(null);
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
    navigate(catalogSearchRoute(search));
  }

  /** Кнопка AI в строке поиска: сразу открывает экран, забирая набранный текст.
   *
   *  Именно ОТКРЫВАЕТ, а не переключает режим. Прежний тумблер только менял
   *  состояние строки, и человек, нажавший «AI», не получал ничего до Enter —
   *  выглядело это как неработающая кнопка. */
  function goAi() {
    const q = search.trim();
    if (q) pushSearchQuery(q);
    track("search_ai_escalated", { query_length: q.length, source: "home_button" });
    navigate(aiSearchRoute(search));
  }

  /** Навигация из поисковой панели: сохранить осмысленный запрос в историю и уйти. */
  function panelNavigate(to: string) {
    const q = search.trim();
    if (q.length >= 2) pushSearchQuery(q);
    setSearch("");
    setSearchOpen(false);
    navigate(to);
  }

  // Чипы навигации: источник и приоритет теперь в navTiles (чистая функция,
  // покрыта тестами). Считаем один раз — hero режет ряд до 6, сайдбар берёт всё.
  const navChips = navTiles(axis, home, categories);
  const heroChips = navChips.slice(0, 6);
  // Ось брендов существует только когда бренды реально пришли: переключатель во
  // вкладку без содержимого — та же мёртвая плитка, только в виде тумблера.
  const hasBrandAxis = (home?.brands ?? []).length > 0;

  function switchAxis(next: NavAxis) {
    setAxis(next);
    track("home_axis_switched", { axis: next });
  }

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
      {/* Верх компактен намеренно: до товарного контента у покупателя раньше
          было три крупных блока подряд (шапка, сетка сценариев, категории), и
          первая карточка появлялась ниже сгиба. Теперь между шапкой и товарами —
          одна строка поиска, одна строка чипов и одна строка сценариев. */}
      <header className="app-hero -mx-4 -mt-3 rounded-b-hero px-4 pb-5 pt-2 text-white shadow-float lg:hidden">
        <div className="flex items-center justify-between gap-3">
          {/* Логотип крупнее кнопок справа намеренно: это единственная точка
              бренда на экране. Прибавку в росте гасим более тесной плашкой и
              подписью, поэтому строка поиска ниже остаётся на прежнем месте. */}
          <div className="min-w-0">
            <BrandLockup height={32} chip />
            <p className="mt-1 truncate text-[11px] font-medium leading-4 text-white/70">Техника, которую легко найти</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => navigate("/favorites")}
              aria-label="Избранное"
              className="tap flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.12]"
            >
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20.7 4.3 13a4.6 4.6 0 0 1 0-6.5 4.6 4.6 0 0 1 6.5 0l1.2 1.2 1.2-1.2a4.6 4.6 0 0 1 6.5 0 4.6 4.6 0 0 1 0 6.5z" />
              </svg>
            </button>
            {/* Постоянный вход в корзину: плавающая панель появляется только с
                товарами, и без этой кнопки пустая корзина была бы недостижима. */}
            <button
              onClick={() => { track("cart_open", { source: "home_header" }); navigate("/cart"); }}
              aria-label={cart.items_count > 0 ? `Корзина: ${cart.items_count}` : "Корзина"}
              className="tap relative flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.12]"
            >
              <CartGlyph className="h-[18px] w-[18px]" />
              {cart.items_count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-accentdark">
                  {cart.items_count}
                </span>
              )}
            </button>
            <ProfileChip user={user} variant="mobile" />
          </div>
        </div>

        {/* Крупный поиск — главный элемент верха (relative: под ним панель подсказок).
            onBlur на обёртке: закрываем панель, только если фокус ушёл наружу
            (кнопки панели держат фокус через preventDefault на mousedown). */}
        <div
          className="relative mt-3 flex gap-2"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSearchOpen(false);
          }}
        >
          {/* Одно поле во всю ширину, кнопка AI — внутри у правого края и
              заметно меньше поля. Раньше рядом стоял тумблер «Каталог / AI»:
              он отъедал ширину у подсказки и, главное, ничего не открывал. */}
          <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-card bg-white py-1.5 pl-4 pr-1.5 text-text shadow-[0_4px_14px_-6px_rgba(9,23,41,0.28)]">
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
              // Подсказка короткая НЕ случайно: рядом стоит тумблер «Каталог /
              // AI», и на 390px поле остаётся шириной 147px. Прежние «Найти
              // iPhone, MacBook, AirPods…» (239px) обрывались на середине слова
              // — обрезанная подсказка хуже короткой. Что продаёт магазин,
              // говорит ряд категорий строкой ниже.
              placeholder="Найти технику"
              aria-label="Поиск по каталогу"
              aria-expanded={searchOpen || search.trim().length >= 2}
              className="h-9 min-w-0 flex-1 bg-transparent text-[15px] font-medium outline-none placeholder:font-normal placeholder:text-muted"
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
            {/* Вход в AI. Кнопка внутри поля и меньше него: она подчинена
                строке, а не спорит с ней за место. Знака Claude здесь нет
                намеренно — движок бывает и не Claude, а бейдж об этом
                утверждает; он живёт на самом экране AI, где сверен с ai_vendor. */}
            <button
              onClick={goAi}
              aria-label={search.trim() ? `Спросить AI: ${search.trim()}` : "Открыть AI-подбор"}
              className="tap flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-white"
            >
              <span aria-hidden>✨</span>
              ИИ
            </button>
          </div>

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

        {/* Ось навигации: категории или бренды. Тумблера нет, пока бренды не
            пришли — переключатель в пустую вкладку хуже отсутствующего. */}
        {hasBrandAxis && (
          <div className="mt-3 flex items-center">
            <SegmentedToggle
              value={axis}
              onChange={switchAxis}
              options={[
                { value: "category", label: "Категории" },
                { value: "brand", label: "Бренды" },
              ] as const}
              ariaLabel="Навигация по каталогу"
              variant="on-dark"
            />
          </div>
        )}

        {/* Быстрые категории — светлые чипы на тёмном hero (сразу видно глубину
            каталога). Данные: админские плитки → каталог → кэш; максимум 6. */}
        <div className={`no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 ${hasBrandAxis ? "mt-2.5" : "mt-3"}`}>
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
            {axis === "brand" ? "Все бренды →" : "Все категории →"}
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
          tiles={navChips}
          axis={axis}
          onAxis={hasBrandAxis ? switchAxis : null}
          onCategory={(route) => navigate(safeInternalRoute(route))}
          onScenario={openScenario}
          onManager={() => { if (!openExternalLink(config.manager_retail_url)) navigate("/ai"); }}
        />

        <div className="min-w-0">
      {/* ===== Hero-баннеры (управляются из админки): mobile — лента, desktop — сетка 3 ===== */}
      {/* Две крупные карточки в горизонтальной ленте: на mobile обе помещаются
          на экран целиком, третья (если админ её завёл) подсказывает прокрутку
          краем. Раньше карточка была 300px шириной — на 390px экране вторая
          пряталась почти полностью, и лента читалась как одиночный баннер. */}
      {/* scroll-px-4 обязателен вместе со snap-mandatory: снап выравнивает карточку
          по границе ПАДДИНГ-БОКСА контейнера, а не по контентной. Без scroll-padding
          браузер сам доводил ленту до snap-позиции ещё на первой отрисовке и съедал
          левые 16px — первый баннер вставал вплотную к краю экрана. */}
      <div
        ref={bannerStrip}
        className="no-scrollbar -mx-4 mt-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 lg:mx-0 lg:mt-0 lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible lg:scroll-px-0 lg:px-0 lg:pb-0"
      >
        {(home ? home.banners : Array.from({ length: 2 }, () => null)).map((b, i) =>
          b ? (
            <HeroBanner
              key={b.id}
              banner={b}
              claudeEnabled={config.ai_vendor === "claude"}
              onOpen={() => {
                if (b.action_type === "external" && b.action_value) {
                  // только http/https: `javascript:`/`data:` из админки не исполняем
                  const ext = safeExternalUrl(b.action_value);
                  if (ext) window.open(ext, "_blank", "noopener,noreferrer");
                  return;
                }
                navigate(safeInternalRoute(actionRoute(b.action_type, b.action_value)));
              }}
            />
          ) : (
            <div key={i} className="skeleton h-[176px] w-[78%] shrink-0 rounded-hero lg:h-[184px] lg:w-auto" />
          ),
        )}
      </div>

      {/* ===== Секции товаров: mobile — ленты/сетка 2, desktop — сетка 4 (5 на wide) =====
          Все три секции ниже (Хиты/Сегодня/Рекомендуем) читают один и тот же /catalog/feed —
          при его сбое раньше секции бесконечно показывали скелетон (feed оставался null
          навсегда). Теперь при ошибке — один явный блок с повтором вместо трёх немых. */}

      {/* v5.2.6: персональные секции — «Недавно смотрели» (если есть история) и «Для вас» */}
      {recentlyViewed && recentlyViewed.length >= 2 && (
        <Section title="Вы недавно смотрели" cards={recentlyViewed}
          onAll={() => navigate("/catalog")} />
      )}
      <Section
        title="Для вас"
        subtitle={recsMode === "cold" ? "Популярное и новое из разных категорий" : "Подобрали по вашим просмотрам"}
        cards={recs === null ? undefined : forYou}
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
          <Section title="Хиты продаж" cards={feed?.hot}
            onAll={() => navigate("/catalog")} />
          <Section title="Забрать сегодня" cards={feed?.available_today}
            onAll={() => navigate("/catalog?today=1")} />
          <Section title="Новинки" cards={feed?.new}
            onAll={() => navigate("/catalog")} />
        </>
      )}

      {/* Desktop-секции (Скидки/Apple/Gaming) — только lg+, mobile-страницу не удлиняем */}
      <div className="hidden lg:block">
        <Section title="Скидки" cards={extra?.sale}
          onAll={() => navigate("/catalog?category=__sale__")} grid />
        <Section title="Apple" cards={extra?.apple}
          onAll={() => navigate("/catalog")} grid />
        <Section title="Gaming" cards={extra?.gaming}
          onAll={() => navigate(`/catalog?category=${encodeURIComponent("консоли")}`)} grid />
      </div>

      {!feedError && alsoLike.length >= 3 && (
        <Section title="Вам также может понравиться" cards={alsoLike}
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

/** Крупный баннер главной (данные из админки).
 *
 *  Два правила, которые легко нарушить обратно:
 *  - emoji рисуем ТОЛЬКО когда изображения нет. Раньше он лежал поверх фото, и
 *    над реальным устройством висел мультяшный значок;
 *  - битая ссылка на изображение не оставляет иконку сломанной картинки: фото
 *    скрывается, остаётся фирменный градиент и читаемый текст.
 */
function HeroBanner({
  banner, onOpen, claudeEnabled,
}: {
  banner: HomeBanner;
  onOpen: () => void;
  claudeEnabled: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const curated = curatedPromo(banner);
  const imageSrc = banner.image_url || curated?.src;
  const hasImage = !!imageSrc && !imageFailed;
  const isCurated = !!curated && !banner.image_url;
  // Готовая афиша: макет уже содержит и заголовок, и цену. Накладывать поверх
  // ещё и наши подписи — значит спорить с картинкой, поэтому текст и затемнение
  // не рисуем вовсе, баннер работает как одна большая кнопка. Признак —
  // пустой subtitle у баннера с картинкой: заголовок остаётся для screen reader.
  const artworkOnly = hasImage && !isCurated && !banner.subtitle;

  return (
    <button
      onClick={onOpen}
      className={`press-surface lift relative aspect-[3/2] h-auto w-[min(82vw,320px)] shrink-0 snap-start overflow-hidden rounded-hero p-4 text-left lg:aspect-auto lg:h-[184px] lg:w-auto lg:p-5 lg:hover:shadow-[0_18px_40px_-14px_rgba(17,24,39,0.22)] ${
        isCurated
          ? "bg-white text-text shadow-card ring-1 ring-inset ring-black/[0.04]"
          : "text-white shadow-float"
      }`}
      style={isCurated ? undefined : {
        background: banner.background_gradient || "linear-gradient(135deg,#1a7fd4,#6d5ae0)",
      }}
    >
      {hasImage && (
        <img
          src={imageSrc!}
          // У афиши весь смысл в самой картинке — её и озвучиваем незрячим,
          // раз подписи поверх нет. У остальных баннеров текст рядом, картинка
          // декоративна и в озвучке только мешала бы.
          alt={artworkOnly ? banner.title : ""}
          loading="lazy" decoding="async"
          onError={() => setImageFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ objectPosition: isCurated ? "72% center" : "center" }}
        />
      )}
      {hasImage && !isCurated && !artworkOnly && (
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/15 to-transparent" />
      )}
      {artworkOnly ? null : (
      <div className="relative z-10 flex h-full max-w-[62%] flex-col justify-end lg:max-w-[66%]">
        {!hasImage && banner.emoji && (
          <span className="mb-auto text-3xl drop-shadow" aria-hidden>{banner.emoji}</span>
        )}
        {isCurated && curated && (
          <span className="mb-auto inline-flex w-fit items-center gap-1 rounded-full bg-white/90 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-text/65 shadow-sm">
            {curated.kind === "claude" && claudeEnabled && <ClaudeMark className="h-3.5 w-3.5" />}
            {curated.kind === "warranty" && (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-emerald-600" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 3 5 6v5c0 4.7 2.8 8.1 7 10 4.2-1.9 7-5.3 7-10V6z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            )}
            {curated.kind === "claude" && claudeEnabled ? "Claude" : curated.eyebrow}
          </span>
        )}
        <p className={`text-[16px] font-extrabold leading-5 lg:text-[18px] lg:leading-6 ${
          isCurated ? "tracking-[-0.02em] text-text" : "drop-shadow"
        }`}>{banner.title}</p>
        {banner.subtitle && (
          <p className={`mt-1 line-clamp-2 text-[12px] font-medium leading-4 lg:text-[13px] ${
            isCurated ? "text-text/60" : "text-white/85 drop-shadow"
          }`}>
            {banner.subtitle}
          </p>
        )}
      </div>
      )}
    </button>
  );
}

function Section({
  title, subtitle, cards, onAll, grid, onOpen,
}: {
  title: string; subtitle?: string; cards?: TCard[];
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
          {cards.map((c) => <ProductCard key={c.id} card={c} onOpen={onOpen} />)}
        </div>
      ) : (
        // mobile — горизонтальная лента, desktop — та же сетка 4/5
        <div className="no-scrollbar stagger -mx-4 mt-3 flex gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:gap-4 lg:overflow-visible lg:px-0 lg:pb-0 wide:grid-cols-5">
          {cards.map((c) => <ProductCard key={c.id} card={c} onOpen={onOpen} compact />)}
        </div>
      )}
    </div>
  );
}

/** Desktop-sidebar главной: категории + быстрые действия (Опт/B2B/Trade-In/менеджер).
 *  Данные те же, что и в mobile-версии; бизнес-логики нет. */
function HomeSidebar({
  tiles, axis, onAxis, onCategory, onScenario, onManager,
}: {
  tiles: NavChip[];
  axis: NavAxis;
  onAxis: ((next: NavAxis) => void) | null;
  onCategory: (route: string) => void;
  onScenario: (k: ScenarioKey) => void;
  onManager: () => void;
}) {
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
        {onAxis ? (
          <div className="px-2 pb-1 pt-2">
            <SegmentedToggle
              value={axis}
              onChange={onAxis}
              options={[
                { value: "category", label: "Категории" },
                { value: "brand", label: "Бренды" },
              ] as const}
              ariaLabel="Навигация по каталогу"
            />
          </div>
        ) : (
          <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Категории</p>
        )}
        {(tiles.length ? tiles : [{ key: "_", label: "Каталог", icon: "🛍️", route: "/catalog" }]).map((c) => (
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
 *  Trade-In/бизнес/опт → встроенная сценарная заявка (bottom sheet).
 *
 *  ОДНА горизонтальная строка, а не сетка 2×3. Короткая вторая строка объясняет
 *  результат нажатия — это превью действия, а не загадочная иконка. Высота всё
 *  ещё достаточно мала, чтобы товарные секции оставались близко к первому экрану. */
function QuickScenarios({
  onCatalog, onScenario, onMacbook,
}: {
  onCatalog: (route: string, scenario: string) => void;
  onScenario: (k: ScenarioKey) => void;
  onMacbook: () => void;
}) {
  const items: { key: string; label: string; detail: string; onClick: () => void }[] = [
    { key: "iphone", label: "iPhone", detail: "Все модели", onClick: () => onCatalog("/catalog?query=iPhone", "buy_iphone") },
    { key: "macbook", label: "MacBook", detail: "Под ваши задачи", onClick: onMacbook },
    { key: "tradein", label: "Trade-In", detail: "Оценим технику", onClick: () => onScenario("trade_in") },
    { key: "b2b", label: "Для бизнеса", detail: "С НДС и документами", onClick: () => onScenario("b2b") },
    { key: "wholesale", label: "Опт", detail: "Цена на партию", onClick: () => onScenario("wholesale") },
    // Плитки «Аксессуары» здесь больше нет: она вела в категорию «аксессуары»,
    // которой в каталоге не существует (кабелей/чехлов/зарядок нет вовсе).
    // Реальные категории показывает блок категорий — он строится из данных.
  ];
  return (
    <div className="no-scrollbar stagger -mx-4 mt-3 flex snap-x snap-proximity scroll-px-4 gap-2.5 overflow-x-auto overscroll-x-contain px-4 pb-1 lg:hidden">
      {items.map((s) => (
        <button
          key={s.key}
          onClick={s.onClick}
          className="card-appear tap flex h-16 w-[clamp(148px,42vw,164px)] shrink-0 snap-start items-center gap-2.5 rounded-xl2 bg-surface px-3 text-left shadow-card ring-1 ring-inset ring-black/[0.035]"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-accent">
            <ScenarioIcon name={s.key} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-bold leading-4 text-text">{s.label}</span>
            <span className="mt-0.5 block truncate text-[11px] font-medium leading-4 text-muted">{s.detail}</span>
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
