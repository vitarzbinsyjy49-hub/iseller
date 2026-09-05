import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track, trackProduct } from "../lib/analytics";
import { useAuthStore } from "../store/auth";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";
import { ScenarioChoiceSheet } from "../components/ScenarioSheet";
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
import { Icon, type IconName } from "../components/icons";
import { navTiles, type NavAxis, type NavChip } from "../lib/navTiles";
import { aiSearchRoute, catalogSearchRoute } from "../lib/searchRoutes";
import { CartGlyph } from "../components/CartBar";
import { useCart } from "../lib/cart";
import { ClaudeMark } from "../components/ClaudeMark";
import { FxRateChip } from "../components/FxRateChip";
import LaunchCountdown from "../components/LaunchCountdown";

const RoadmapSheet = lazy(() => import("../components/RoadmapSheet"));
const AboutServiceSheet = lazy(() => import("../components/AboutServiceSheet"));
// Как соседние шторки выше: открывается только тапом по чипу, в основной
// чанк первого экрана попадать не должна (мобильные сети, Mini App).
const FxRateSheet = lazy(() => import("../components/FxRateSheet"));
import { autoplayReady, nextSlideIndex, snapTargetLeft } from "../lib/carousel";
import { animateScrollTo } from "../lib/motion";
import { useCollapsingHeader } from "../lib/useCollapsingHeader";
import { enterGridRefCallback, enterRefCallback } from "../lib/useEnter";

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
  // Срок держим равным тому, что стоит в карточке товара (warranty_months).
  // Запасная плитка видна, когда backend недоступен, — и именно тогда ошибиться
  // в обещании легче всего: проверить его не по чему.
  { id: -5, title: "Техника с гарантией", subtitle: "Гарантия 1 месяц и проверка при вас", action_type: "collection", action_value: "hot" },
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

  useEffect(() => {
    const el = ref.current;
    if (!el || count <= 1) return;

    // Жест человека обрывает нашу анимацию: доводить ленту до «своего» баннера
    // под пальцем — это отнимать управление посреди движения.
    const touched = () => {
      lastInteractionAt.current = Date.now();
      cancelScroll.current();
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

      // Геометрия одна и для «где мы сейчас», и для «куда едем»: считать эти
      // две вещи по-разному значит однажды поехать не туда, откуда считали.
      const geometry = {
        stripOffsetLeft: strip.offsetLeft,
        scrollPaddingLeft: parseFloat(getComputedStyle(strip).scrollPaddingLeft) || 0,
        maxScrollLeft: strip.scrollWidth - strip.clientWidth,
      };
      const stopAt = (node: HTMLElement) => snapTargetLeft({ ...geometry, slideOffsetLeft: node.offsetLeft });

      // Текущий слайд — тот, чья точка остановки ближе всего к текущей позиции.
      const current = slides.reduce(
        (best, node, i) =>
          Math.abs(stopAt(node) - strip.scrollLeft) < Math.abs(stopAt(slides[best]) - strip.scrollLeft) ? i : best,
        0,
      );
      const left = stopAt(slides[nextSlideIndex(current, slides.length)]);

      // Лента ВСЕГДА едет, даже при системном «уменьшить движение». Это
      // осознанное решение владельца магазина, а не недосмотр: то же самое
      // движение человек получает под собственным пальцем, и подменять его
      // растворением значит показывать другой интерфейс тем же самым людям.
      // Настройка продолжает действовать на остальное (см. index.css и
      // transitionDuration в lib/motion) — здесь она снята точечно.
      cancelScroll.current();
      cancelScroll.current = animateScrollTo(strip, left, BANNER_SLIDE_MS);
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
      cancelScroll.current();
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
  // Крупный заголовок тает под липкой шапкой при прокрутке. Ref на весь верх:
  // внутри хук сам находит обе части по data-атрибутам в разметке ниже.
  const collapsingHeader = useCollapsingHeader();
  // v6: Trade-In/бизнес/опт ведут в AI-чат заявки (/apply/:scenario) вместо
  // встроенного bottom-sheet. Меню MacBook (v5.4.0) остаётся как есть — это
  // prefill в /ai, не lead-сценарий.
  const [macbookOpen, setMacbookOpen] = useState(false);

  function openScenario(k: ScenarioKey) {
    track("quick_scenario_clicked", { scenario: k });
    navigate(`/apply/${k}`);
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
  const [roadmap, setRoadmap] = useState(false);
  const [about, setAbout] = useState(false);
  const [fxSheetOpen, setFxSheetOpen] = useState(false);
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
    <div ref={collapsingHeader} className="mx-auto max-w-md lg:max-w-none">
      {/* ===== Единый верх: системная область Telegram + hero одного цвета. Тёмную
          подложку выреза статус-бара даёт глобальный .hero-top-inset в Layout (на
          всех экранах); здесь только сам hero. ===== */}
      {/* Верх компактен намеренно: до товарного контента у покупателя раньше
          было три крупных блока подряд (шапка, сетка сценариев, категории), и
          первая карточка появлялась ниже сгиба. Теперь между шапкой и товарами —
          одна строка поиска, одна строка чипов и одна строка сценариев. */}
      {/* pb-2, а не pb-4: у ряда категорий высота 44px — цель касания вокруг
          13-пиксельного текста, то есть по 14px невидимого поля сверху и снизу.
          Складываясь с отступом шапки и отступом сетки, это давало 46px пустоты
          между категориями и плитками (замерено). Цель касания должна ПОМЕЩАТЬСЯ
          в отступ, а не добавляться к нему. */}
      {/* Липкая шапка — ПРЯМОЙ ребёнок страницы, а не часть верхнего блока, и
          это не стилистика. `position: sticky` действует только внутри коробки
          родителя: пока шапка лежала внутри <header> вместе с заголовком и
          поиском, она уезжала с экрана ровно тогда, когда этот блок кончался, —
          то есть переставала быть липкой на первом же экране товаров (поймано на
          стенде). Родителем обязан быть контейнер во всю высоту страницы.

          -mx-4/-mt-3 гасят отступы <main> (px-4 pt-3): фон шапки должен доходить
          до кромок экрана и начинаться от самого верха, а собственный padding
          она возвращает уже внутри себя. */}
      <header data-collapsing-nav className="app-navbar -mx-4 -mt-3 px-4 pb-2 pt-2 lg:hidden">
        <div className="flex items-center justify-between gap-3">
          {/* Знак бренда уехал в полосу плавающих кнопок Telegram (Layout,
              .hero-top-inset). Освободившийся слот занимает мелкий заголовок:
              он проявляется ровно по мере таяния крупного (data-collapsing-title
              ниже), и шапка не остаётся с дырой на месте логотипа.
              opacity: 0 в разметке — стартовое состояние; дальше значение
              покадрово пишет lib/useCollapsingHeader.ts. */}
          <div className="min-w-0">
            <span
              data-collapsing-smalltitle
              style={{ opacity: 0 }}
              className="block truncate text-[15px] font-semibold tracking-tight"
            >
              Техника, которую легко найти
            </span>
          </div>
          <HeroActions
            cartCount={cart.items_count}
            onFavorites={() => navigate("/favorites")}
            onCart={() => { track("cart_open", { source: "home_header" }); navigate("/cart"); }}
            profile={<ProfileChip user={user} variant="mobile" />}
          />
        </div>
      </header>

      <div className="pb-2 lg:hidden">
        {/* До 27.08 15:15 — полоса обратного отсчёта, после исчезает сама.
            Тап ведёт в тот же роудмап, что и строка «Что будет дальше» в
            профиле: пока полоса есть, это самый заметный вход в планы. */}
        <LaunchCountdown
          onOpenRoadmap={() => { track("beta_roadmap_opened", { source: "home_launch" }); setRoadmap(true); }}
        />

        {/* Фраза бренда переехала сюда из-под логотипа и вместе с местом сменила
            вес: 11px серым она была подписью к картинке, а на первом экране
            магазина главный вопрос — «что здесь можно найти». Текст тот же, но
            теперь он отвечает на него, а не украшает шапку.
            26px вместо 20 и <h1> вместо <p>: это заголовок ЭКРАНА, а не подпись
            к чему-то, и он единственный, кто на этом верху имеет право быть
            крупным. Пока он был одного веса с остальными пятью рядами, у экрана
            не было главного элемента вовсе — отсюда и ощущение веб-страницы.
            Растворяется при прокрутке (data-collapsing-title). */}
        <h1
          data-collapsing-title
          className="mt-1 text-h1 font-bold tracking-tight [text-wrap:balance]"
        >
          Техника, которую легко найти
        </h1>

        {/* Крупный поиск — главный элемент верха (relative: под ним панель подсказок).
            onBlur на обёртке: закрываем панель, только если фокус ушёл наружу
            (кнопки панели держат фокус через preventDefault на mousedown). */}
        <div
          className="relative mt-2.5 flex gap-2"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSearchOpen(false);
          }}
        >
          {/* Одно поле во всю ширину, кнопка AI — внутри у правого края и
              заметно меньше поля. Раньше рядом стоял тумблер «Каталог / AI»:
              он отъедал ширину у подсказки и, главное, ничего не открывал. */}
          {/* Волосяная рамка вместо тени: поле лежит на странице, а не парит
              над ней. Тень нужна была, чтобы белое читалось на синем; синего
              больше нет, и тень осталась бы украшением. */}
          <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-card border border-border bg-surface py-1.5 pl-4 pr-1.5 text-text">
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
              // rounded-field, а не rounded-full: залитая пилюля с текстом —
              // это форма «по умолчанию для всего», от которой мы уходим.
              // Круглыми остаются только кнопки-иконки, где круг задан
              // содержимым, а не вкусом.
              className="tap flex h-9 shrink-0 items-center gap-1.5 rounded-field bg-accent px-3.5 text-[13px] font-semibold text-white"
            >
              <Icon name="sparkles" className="h-4 w-4" strokeWidth={2} />
              ИИ
            </button>
          </div>

          {/* Умная поисковая панель: по фокусу — история/чипы/недавние/AI,
              при вводе — live-результаты (debounce + AbortController внутри).
              mousedown preventDefault: тап по панели не блюрит инпут, клик доходит. */}
          {(searchOpen || search.trim().length >= 2) && (
            <div
              ref={enterRefCallback("fade")}
              onMouseDown={(e) => e.preventDefault()}
              className="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-xl2 bg-white text-text shadow-sheet"
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

        {/* Ось навигации (категории/бренды) слева, курс USD справа. Строка
            рисуется, если есть ХОТЯ БЫ ОДНО из двух — тумблера нет, пока
            бренды не пришли, чип нет, пока в fx_rate_history нет строк. */}
        {(hasBrandAxis || config.usd_rate) && (
          <div className="mt-3 flex items-center justify-between">
            {hasBrandAxis ? (
              <SegmentedToggle
                value={axis}
                onChange={switchAxis}
                options={[
                  { value: "category", label: "Категории" },
                  { value: "brand", label: "Бренды" },
                ] as const}
                ariaLabel="Навигация по каталогу"
                variant="on-surface"
              />
            ) : <div />}
            <FxRateChip usdRate={config.usd_rate} onClick={() => setFxSheetOpen(true)} />
          </div>
        )}

        {fxSheetOpen && config.usd_rate && (
          <Suspense fallback={null}>
            <FxRateSheet usdRate={config.usd_rate} onClose={() => setFxSheetOpen(false)} />
          </Suspense>
        )}

        {/* Категории — элементы с волосяной рамкой, радиус общей шкалы (12px).
            Не пилюли и не голый текст, и оба отказа по делу.
            Пилюля (радиус 999) — форма «по умолчанию для всего», от которой мы
            уходим. Голый текст был перебором в другую сторону: у надписи нет ни
            границы, ни фона, ни подчёркивания — ни одного признака, по которому
            глаз отличает «нажми» от «прочитай». Убрав подложку, я убрал вместе с
            ней и сигнал.
            Рамка — тот же язык, которым в каталоге говорят «Популярные ▾» и
            «Фильтры · N»: об управляющих элементах приложение обязано говорить
            одинаково на всех экранах.
            Подчёркивание сюда не годится: в каталоге оно значит «эта категория
            ВЫБРАНА», а здесь выбранной нет — все ссылки равноправны. Один знак с
            двумя смыслами хуже двух разных знаков.
            Данные: админские плитки → каталог → кэш; максимум 6. */}
        {/* bg-surface/70, а не сплошной белый — и это не украшение, а иерархия
            материалов. Раньше весь верх состоял из девяти одинаковых белых
            пилюль (действия, поиск, кнопка ИИ, тумблер осей, курс, четыре
            категории): один радиус, одна заливка, один вес — экран читался как
            выгрузка библиотеки компонентов. Теперь материал говорит о роли:
            поиск сплошной, потому что это поле ввода и оно главное; категории
            полупрозрачны и живой фон идёт сквозь них; шапка — стекло. Текст на
            них по-прежнему почти чёрный (контраст ~14:1), читаемость не
            тронута. */}
        <div className={`no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 ${hasBrandAxis ? "mt-2" : "mt-3"}`}>
          {heroChips.map((c) => (
            <button
              key={c.key}
              onClick={() => navigate(safeInternalRoute(c.route))}
              className="tap flex h-11 shrink-0 items-center whitespace-nowrap rounded-field border border-border bg-surface/70 px-3.5 text-footnote font-medium text-text outline-none transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
            >
              {c.label}
            </button>
          ))}
          <button
            onClick={() => navigate("/catalog")}
            className="tap flex h-11 shrink-0 items-center whitespace-nowrap rounded-field border border-border bg-surface/70 px-3.5 text-footnote font-medium text-accent outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent"
          >
            {axis === "brand" ? "Все бренды →" : "Все категории →"}
          </button>
        </div>
      </div>

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
        onSellItem={() => { track("quick_scenario_clicked", { scenario: "sell_item" }); navigate("/sell"); }}
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
        // mt-4: ряд плиток выше стал сеткой и лишился собственного pb-1,
        // которым раньше добиралось расстояние. Просветы над плитками и под
        // ними снова по 16px.
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
          className="tap mt-3 inline-flex items-center gap-2 rounded-field bg-mutedbg px-5 py-2.5 text-[13px] font-semibold text-text transition-colors hover:bg-accent hover:text-white"
        >
          <Icon name="chat" className="h-4 w-4" />
          Оставить заявку
        </button>
      </div>

      {/* Юридический дисклеймер: неяркая ссылка в самом низу главной, не
          спорит по весу с товарными секциями и CTA выше. */}
      <button
        onClick={() => { track("about_service_opened", { source: "home_footer" }); setAbout(true); }}
        className="tap mt-6 flex w-full items-center justify-center gap-1 py-2 text-[11px] text-muted/70 outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Icon name="info" className="h-3.5 w-3.5" />
        О сервисе
      </button>

        </div>{/* /контент */}
      </div>{/* /desktop grid */}

      {consult && (
        <LeadForm
          productId={null} productTitle={null} productPrice={null}
          source="manager" presetMessage="Ищу модель, которой нет в каталоге"
          onClose={() => setConsult(false)}
        />
      )}

      {/* Отдельным chunk'ом: роудмап открывают единицы, а весит он как экран. */}
      {roadmap && (
        <Suspense fallback={null}>
          <RoadmapSheet onClose={() => setRoadmap(false)} />
        </Suspense>
      )}
      {about && (
        <Suspense fallback={null}>
          <AboutServiceSheet onClose={() => setAbout(false)} />
        </Suspense>
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

function HeartGlyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20.7 4.3 13a4.6 4.6 0 0 1 0-6.5 4.6 4.6 0 0 1 6.5 0l1.2 1.2 1.2-1.2a4.6 4.6 0 0 1 6.5 0 4.6 4.6 0 0 1 0 6.5z" />
    </svg>
  );
}

function CartCount({ count, offset }: { count: number; offset: string }) {
  if (count <= 0) return null;
  return (
    <span className={`absolute ${offset} flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-accentdark`}>
      {count}
    </span>
  );
}

/** Правый угол шапки: избранное и корзина одной «пилюлей», аватар отдельно.
 *
 *  Три одинаковых круглых кнопки подряд читались как три равных по важности
 *  входа и спорили за внимание с логотипом слева. Избранное и корзина — вещи
 *  одного рода («мои списки»), поэтому стоят одним объектом; аватар — другого,
 *  и потому отделён. Вместо трёх конкурирующих кружков в углу два объекта. */
function HeroActions({
  cartCount, onFavorites, onCart, profile,
}: {
  cartCount: number;
  onFavorites: () => void;
  onCart: () => void;
  profile: React.ReactNode;
}) {
  const cartLabel = cartCount > 0 ? `Корзина: ${cartCount}` : "Корзина";

  return (
    <div className="flex shrink-0 items-center gap-2">
      {/* Пилюля выросла с 36 до 44px: избранное и корзина — самые верхние
          действия экрана, и 32px высоты по правилу 44×44 им мало. */}
      <div className="flex items-center rounded-full bg-mutedbg">
        <button onClick={onFavorites} aria-label="Избранное" className="tap flex h-11 w-11 items-center justify-center rounded-full text-text outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <HeartGlyph className="h-[18px] w-[18px]" />
        </button>
        <span aria-hidden className="h-4 w-px bg-border" />
        <button onClick={onCart} aria-label={cartLabel} className="tap relative flex h-11 w-11 items-center justify-center rounded-full text-text outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <CartGlyph className="h-[18px] w-[18px]" />
          <CartCount count={cartCount} offset="right-2 top-1.5" />
        </button>
      </div>
      {profile}
    </div>
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
        {/* -my-3 + py-3: область нажатия 44px, при этом ссылка визуально стоит
            там же, где стояла — вертикальный ритм секции не меняется. */}
        <button onClick={onAll} className="-my-3.5 shrink-0 rounded-field px-1 py-3.5 text-xs font-medium text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent">Смотреть все</button>
      </div>
      {grid ? (
        // mobile 2 кол -> tablet 3 -> desktop 4 -> wide 5
        <div className="stagger mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {cards.map((c) => <ProductCard key={c.id} card={c} onOpen={onOpen} />)}
        </div>
      ) : (
        // mobile — горизонтальная лента, desktop — та же сетка 4/5
        // pt-0.5 — не «воздух», а место под рамку легендарной карточки. Она
        // нарисована box-shadow'ом на 1.5px НАРУЖУ коробки, а лента прокрутки
        // (overflow-x:auto делает вычисленный overflow-y тоже auto) срезает
        // всё, что вышло за её край. Снизу рамку спасал pb-2, сверху спасать
        // было нечем — и золотой порог у карточки был только с трёх сторон.
        // Отступ сверху компенсируем меньшим mt, чтобы просвет не вырос.
        <div className="no-scrollbar stagger -mx-4 mt-2.5 flex gap-3 overflow-x-auto px-4 pb-2 pt-0.5 lg:mx-0 lg:grid lg:grid-cols-4 lg:gap-4 lg:overflow-visible lg:px-0 lg:pb-0 wide:grid-cols-5">
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
  const actions: { icon: IconName; label: string; sub: string; onClick: () => void }[] = [
    { icon: "box", label: "Опт", sub: "Партии от 5 шт", onClick: () => onScenario("wholesale") },
    { icon: "building", label: "Поставка для компании", sub: "Документы для юрлиц", onClick: () => onScenario("b2b") },
    { icon: "refresh", label: "Trade-In", sub: "Обмен и выкуп техники", onClick: () => onScenario("trade_in") },
    { icon: "chat", label: "Написать менеджеру", sub: "Ответим быстро", onClick: onManager },
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
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-mutedbg text-muted">
              <Icon name={a.icon} className="h-[18px] w-[18px]" />
            </span>
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
      case "sell_item":  // ценник-бирка
        return <><path d="M11 3h6a2 2 0 0 1 2 2v6L10 20l-9-9L10 3z" /><circle cx="15" cy="8" r="1.4" /></>;
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
 *  Один ряд из 4, а не сетка 2×2: после добавления «Продать» 2×2 удваивала
 *  высоту блока на каждой загрузке главной — цена за это была слишком
 *  высокой ради подписи-пояснения под каждой плиткой. Вернулись к высоте
 *  исходного ряда из 3, пожертвовав второй строкой текста: подписи «Trade-In»
 *  и «Продать» разные сами по себе, риск разовой путаницы дешевле полноэкранной
 *  просадки. Лента (горизонтальный скролл) здесь не вариант — см. комментарий
 *  ниже, в проекте уже отказывались от неё по этой же причине для чипов
 *  категорий. */
function QuickScenarios({
  onCatalog, onScenario, onMacbook, onSellItem,
}: {
  onCatalog: (route: string, scenario: string) => void;
  onScenario: (k: ScenarioKey) => void;
  onMacbook: () => void;
  onSellItem: () => void;
}) {
  // Осталось два пункта из четырёх. «Бизнесу» и «Опт» — не то же самое, что
  // Trade-In и «Продать»: первые два делает обычный покупатель, вторые два
  // адресованы юрлицам, и попадают туда единицы. Четыре РАВНЫЕ плитки — это
  // отказ решать, что важнее, и платит за него первый экран.
  //
  // Из приложения они никуда не делись: обе строки уже стояли в профиле, в
  // блоке «Связаться с нами» («Оптовая закупка», «Поставка для компании»), —
  // то есть на главной они были вторым показом одного и того же.
  const items: { key: string; label: string; onClick: () => void }[] = [
    { key: "tradein", label: "Trade-In", onClick: () => onScenario("trade_in") },
    { key: "sell_item", label: "Продать", onClick: onSellItem },
    // Плитки «Аксессуары» здесь больше нет: она вела в категорию «аксессуары»,
    // которой в каталоге не существует (кабелей/чехлов/зарядок нет вовсе).
    // Реальные категории показывает блок категорий — он строится из данных.
    //
    // iPhone и MacBook отсюда убраны как ТРЕТИЙ показ одного и того же: выше
    // чипы «Смартфоны/Ноутбуки», ниже баннеры «iPhone в наличии» и «MacBook
    // для работы». Повтор не помогал выбрать — он забирал место у того, чего
    // на главной больше нигде нет: обмена, счёта юрлицу и цены на партию.
  ];
  return (
    // mt-4, а не mt-3: между шапкой, рядом плиток и лентой баннеров теперь
    // ровно 16px в обоих просветах. Было 12 и 20 — глаз читал это как «плитки
    // прилипли к шапке и отвалились от ленты».
    // Сетка, а не лента: все пункты видны целиком без прокрутки. Лента здесь
    // была третьей подряд — чипы категорий в шапке, эта, лента баннеров, — и
    // три листающиеся полосы читались одинаково важными. Плюс лента всегда
    // обрезает пункт по правому краю: человек видит, что «там ещё что-то
    // есть», но не знает что. Когда видно всё, ни прокрутка, ни привязка, ни
    // обрез не нужны — их тут больше и нет.
    //
    // Тени и обводки сняты намеренно. Это не товар и не карточка: подложка
    // тоном отделяет пункт от фона, а поднимать его над страницей незачем —
    // рядом стоят настоящие карточки товаров, и спорить с ними по весу
    // служебные ссылки не должны.
    <div className="stagger mt-4 grid grid-cols-2 gap-2 lg:hidden">
      {items.map((s) => (
        <button
          key={s.key}
          ref={enterGridRefCallback("fadeUp")}
          onClick={s.onClick}
          // min-h-11 (44px) держит тач-таргет на минимуме, даже когда сама
          // плитка визуально компактнее — иконка+подпись сами по себе ниже.
          className="tap flex min-h-11 min-w-0 flex-col items-center gap-1 rounded-xl2 bg-mutedbg px-1 py-2 text-center"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-accent">
            <ScenarioIcon name={s.key} />
          </span>
          <span className="line-clamp-1 block max-w-full text-[11px] font-bold leading-[1.2] text-text">{s.label}</span>
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
