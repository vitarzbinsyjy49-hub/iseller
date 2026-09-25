import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { TYPEWRITER_TIMING_CALM } from "../lib/typewriter";
import { useTypewriterPlaceholder } from "../lib/useTypewriterPlaceholder";
import { SEARCH_HINTS, SEARCH_PLACEHOLDER } from "../lib/searchHints";
import { useNavigate } from "react-router-dom";
import { cachedApi, SHOP } from "../lib/apiCache";
import { track, trackProduct } from "../lib/analytics";
import { useAuthStore } from "../store/auth";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";
import { type ScenarioKey } from "../lib/scenario";
import { usePublicConfig } from "../lib/appConfig";
import { openExternalLink } from "../lib/telegram";
import { managerLink } from "../lib/managerLink";
import { edgeColor, inkOn, SURFACE_SAMPLE, type Rgb } from "../lib/bannerSurface";
import { ProfileChip } from "../components/ProfileChip";
import { ErrorState } from "../components/StateViews";
import SearchPanel from "../components/SearchPanel";
import HeroSlot from "../components/HeroSlot";
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
import LaunchCountdown from "../components/LaunchCountdown";

const RoadmapSheet = lazy(() => import("../components/RoadmapSheet"));
const AboutServiceSheet = lazy(() => import("../components/AboutServiceSheet"));
import { autoplayReady, nextSlideIndex, snapTargetLeft } from "../lib/carousel";
import { animateScrollTo } from "../lib/motion";
import { useCollapsingHeader } from "../lib/useCollapsingHeader";
import { useMediaQuery } from "../lib/useMediaQuery";
import { enterGridRefCallback, enterRefCallback } from "../lib/useEnter";

type Category = { key: string; label: string; icon: string; count: number };
type Feed = {
  // Предзаказ стоит первым намеренно: это единственная секция, которая может
  // исчезнуть целиком. Пустой массив Section гасит сам — отдельного
  // выключателя не нужно, тот же инвариант, что у плиток категорий.
  preorder: TCard[];
  hot: TCard[]; available_today: TCard[]; new: TCard[]; recommended: TCard[];
};

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

/** Заголовок экрана — живёт в одной константе, а не в двух местах разметки.
 *  Мелкий заголовок в шапке (data-collapsing-smalltitle) и крупный <h1>
 *  ниже (data-collapsing-title) показывают ОДИН И ТОТ ЖЕ текст: один
 *  проявляется по мере таяния другого при скролле, оба видимы одновременно
 *  на части пути прокрутки. Раздельные строковые литералы разъехались бы
 *  при правке одного из двух мест незаметно для автора правки. */
const HOME_HEADLINE = "Техника, которую легко найти";

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
  // Desktop-блоки (сайдбар и секции Скидки/Apple/Gaming) на телефоне НЕ
  // МОНТИРУЮТСЯ, а не прячутся display:none. Прежний `hidden lg:block` скрывал
  // их от глаз, но не от браузера: три запроса /catalog/list на каждый заход с
  // телефона, полторы сотни ProductCard со своими подписками и анимацией
  // появления, и почти две тысячи узлов в невидимом поддереве — они же
  // попадали в снимок перехода между экранами (замер в lib/useRouteTransition).
  // Классы hidden lg:block на самих блоках остаются: на desktop ничего не
  // меняется.
  const desktop = useMediaQuery("(min-width: 1024px)");
  // v6: Trade-In/бизнес/опт ведут в AI-чат заявки (/apply/:scenario) вместо
  // встроенного bottom-sheet. Меню MacBook (v5.4.0) остаётся как есть — это
  // prefill в /ai, не lead-сценарий.

  function openScenario(k: ScenarioKey) {
    track("quick_scenario_clicked", { scenario: k });
    navigate(`/apply/${k}`);
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
  const [search, setSearch] = useState("");
  // Панель умного поиска: открыта по фокусу (полезное пустое состояние) или
  // при вводе (live-результаты). Содержимое — SearchPanel; debounce и отмена
  // запросов (AbortController) — в lib/liveSearch.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Бегущая подсказка. Спокойный тайминг, а не тот, что внизу: здесь она идёт
  // фоном, пока человек осматривается, и обычная скорость выглядела бы суетой
  // в углу экрана. Работает ТОЛЬКО пока поле пустое и закрыто — как только
  // человек сфокусировался или начал печатать, подсказке место уступается.
  useTypewriterPlaceholder(
    searchInputRef,
    SEARCH_HINTS,
    !searchOpen && search === "",
    SEARCH_PLACEHOLDER,
    TYPEWRITER_TIMING_CALM,
  );
  // v5.2.6: персональные секции («Для вас», «Недавно смотрели»)
  const [recs, setRecs] = useState<TCard[] | null>(null);
  const [recsMode, setRecsMode] = useState<string>("cold");
  const [recentlyViewed, setRecentlyViewed] = useState<TCard[] | null>(null);

  const loadFeed = useCallback(() => {
    setFeed(null);
    setFeedError(false);
    cachedApi<Feed>(SHOP.feed).then(setFeed).catch(() => setFeedError(true));
  }, []);

  useEffect(() => {
    track("app_opened");
    cachedApi<HomeData>(SHOP.home)
      .then((d) => setHome(d))
      .catch(() => setHome({ banners: FALLBACK_PROMOS, categories: [] }));
    cachedApi<{ categories: Category[] }>(SHOP.categories)
      .then((d) => { setCategories(d.categories); saveCachedCategories(d.categories); })
      .catch(() => {});
    loadFeed();
    // Персональные рекомендации и «недавно смотрели» (v5.2.6)
    cachedApi<{ cards?: TCard[]; mode?: string }>("/catalog/recommendations?limit=12")
      .then((d) => { setRecs(d.cards ?? []); setRecsMode(d.mode ?? "cold"); })
      .catch(() => setRecs([]));
    cachedApi<{ cards?: TCard[] }>("/catalog/recently-viewed?limit=10")
      .then((d) => setRecentlyViewed(d.cards ?? []))
      .catch(() => setRecentlyViewed([]));
  }, [loadFeed]);

  // Секции desktop-главной; ошибки не критичны — секция просто не показывается.
  // Только на desktop: на телефоне эти три ответа кормили невидимый блок.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    Promise.all([
      cachedApi<{ cards?: TCard[] }>("/catalog/list?category=__sale__&sort=popularity").then((d) => d.cards ?? []).catch(() => []),
      cachedApi<{ cards?: TCard[] }>("/catalog/list?brand=Apple&sort=popularity").then((d) => d.cards ?? []).catch(() => []),
      cachedApi<{ cards?: TCard[] }>(`/catalog/list?category=${encodeURIComponent("консоли")}&sort=popularity`).then((d) => d.cards ?? []).catch(() => []),
    ]).then(([sale, apple, gaming]) => { if (!cancelled) setExtra({ sale, apple, gaming }); });
    return () => { cancelled = true; };
  }, [desktop]);

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
              .hero-top-inset), и слот делят ДВА узла, лежащих друг на друге.

              В покое — HeroSlot: живая заявка, а если её нет, точка выдачи.
              При прокрутке — мелкий заголовок экрана, проявляющийся по мере
              таяния крупного. Прозрачности ведёт мотор в противофазе
              (lib/useCollapsingHeader.ts), их сумма всегда равна единице.

              Стопка, а не два соседних места: показывать их одновременно
              незачем — человек читает то одно, то другое, а шапка от второго
              места выросла бы вдвое. grid с одной ячейкой держит оба узла в
              одной коробке, и высота считается по большему из них.

              opacity: 0 у заголовка в разметке — стартовое состояние; дальше
              значение покадрово пишет мотор.
              aria-hidden: тот же текст уже есть в <h1> ниже (HOME_HEADLINE),
              и opacity: 0 его из дерева доступности не убирает — оба узла
              видны скринридеру одновременно, и без aria-hidden фраза
              звучала бы дважды подряд. */}
          <div className="grid min-w-0 flex-1 [grid-template-areas:'slot'] [&>*]:[grid-area:slot] [&>*]:self-center">
            <HeroSlot />
            {/* pointer-events-none обязателен и не про стиль.
                Заголовок лежит в ТОЙ ЖЕ ячейке сетки, что и статусная строка, и
                идёт в разметке позже — значит, рисуется поверх. При opacity: 0
                он невидим, но из попадания по координатам НЕ исчезает: браузер
                отдаёт тап ему, а не кнопке под ним. Статус и курс из-за этого
                просто не нажимались.
                Поймать это программным .click() нельзя — тот вызывается на
                элементе напрямую и слой сверху не проверяет. Проверять такое
                можно только elementFromPoint или живым пальцем.
                Элемент декоративный (aria-hidden), события ему не нужны ни в
                одном состоянии — ни спрятанным, ни проявленным. */}
            <span
              data-collapsing-smalltitle
              aria-hidden="true"
              style={{ opacity: 0 }}
              className="pointer-events-none block truncate text-[15px] font-semibold tracking-tight"
            >
              {HOME_HEADLINE}
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

        {/* Крупного заголовка здесь больше нет.
            «Техника, которую легко найти» — слоган: он занимал 64px первого
            экрана (замер) и не сообщал ничего, чего не сообщает сам магазин.
            Приём с тающим крупным заголовком — системный для ЗАГОЛОВКОВ
            НАВИГАЦИИ в iOS, а не для витрины: ни один магазин, с которым нас
            сравнивают, на главной его не держит.
            Название при этом не потеряно — оно приезжает в липкую шапку при
            прокрутке (data-collapsing-smalltitle там же). Без пары
            data-collapsing-title хук просто уводит прогресс в единицу с первой
            прокрутки, то есть шапка «наливается» сразу — для липкого поиска это
            и нужно (см. lib/useCollapsingHeader.ts). */}

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
          <div className="flex h-control min-w-0 flex-1 items-center gap-2.5 rounded-field border border-border bg-surface pl-4 pr-1.5 text-text">
            <svg viewBox="0 0 24 24" className="h-icon w-icon shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
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
              ref={searchInputRef}
              placeholder={SEARCH_PLACEHOLDER}
              aria-label="Поиск по каталогу"
              aria-expanded={searchOpen || search.trim().length >= 2}
              className="self-stretch min-w-0 flex-1 bg-transparent text-[15px] font-medium outline-none placeholder:font-normal placeholder:text-muted"
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
              className="tap tap-area-control relative flex h-[34px] shrink-0 items-center gap-1.5 rounded-field bg-accent px-3.5 text-[13px] font-semibold text-white"
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

        {/* Тумблера «Категории / Бренды» здесь больше нет, и ряда категорий
            ниже — тоже. Целый этаж уходил на переключение оси каталога, ещё
            один — на ссылки в него же, а каталог у нас отдельная вкладка нижней
            навигации. Дублировать её на витрине значило соревноваться с самим
            собой: человек, которому нужен каталог, нажимает «Каталог».
            Курс, стоявший в этой строке справа, уехал в шапку — к режиму
            работы, где ему и место по смыслу. */}


        {/* Ряд категорий отсюда убран вместе с тумблером осей.
            Это были ссылки из витрины в каталог, у которого есть собственная
            вкладка в нижней навигации. Витрина соревновалась с ней за ту же
            задачу и проигрывала: чтобы дойти до нужной категории, всё равно
            приходилось открывать каталог — ряд показывал шесть из десятка.
            Поиск и AI-подбор остаются: они находят товар, а не ведут в список.

            `axis`, `navChips` и `switchAxis` в компоненте СОХРАНЕНЫ и мёртвым
            кодом не являются — ими живёт desktop-сайдбар ниже (там ряд
            категорий уместен: место есть, и он не конкурирует с нижней
            навигацией, которой на desktop нет). `heroChips` продолжает питать
            панель подсказок под поиском. Убрана только мобильная витрина. */}
      </div>

      {/* ===== Быстрые сценарии (mobile): не категории, а намерения пользователя.
          Товарные ведут в каталог, консультационные — к профильному менеджеру из
          public config (пустая ссылка → существующий fallback: AI-консультант).
          На desktop аналогичные действия уже есть в сайдбаре — не дублируем. ===== */}
      <QuickScenarios
        onScenario={openScenario}
        onSellItem={() => { track("quick_scenario_clicked", { scenario: "sell_item" }); navigate("/sell"); }}
        onAi={() => { track("quick_scenario_clicked", { scenario: "ai_pick" }); navigate("/ai"); }}
        onMarketplace={() => { track("quick_scenario_clicked", { scenario: "marketplace" }); navigate("/marketplace"); }}
      />

      {/* ===== Desktop: сетка [sidebar 260px | контент] ===== */}
      <div className="lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-8">
        {desktop && (
          <HomeSidebar
            tiles={navChips}
            axis={axis}
            onAxis={hasBrandAxis ? switchAxis : null}
            onCategory={(route) => navigate(safeInternalRoute(route))}
            onScenario={openScenario}
            onManager={() => { if (!openExternalLink(config.manager_retail_url)) navigate("/ai"); }}
          />
        )}

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
            <div key={i} className="skeleton aspect-[3/2] w-[min(82vw,320px)] shrink-0 rounded-hero lg:aspect-auto lg:h-[184px] lg:w-auto" />
          ),
        )}
      </div>

      {/* ===== Чем мы отличаемся — строкой под афишей =====

          Это те же обещания, которые написаны в «Информации», вынесенные туда,
          где их читают. Раньше они жили слайдами карусели («Техника с
          гарантией» — пятым из шести): до них не долистывали, то есть УТП
          формально было и фактически не работало.

          Каждый факт ведёт в СВОЙ раздел, а не в оглавление: человек тапает по
          тому, что его беспокоит, и попадает на ответ. Новых экранов для этого
          заводить не пришлось — все три адреса уже существуют.

          Кнопка менеджера стоит здесь же и переехала сюда из шапки (HeroSlot):
          связь с живым человеком — такое же обещание, как проверка и оплата
          после неё, и читается оно в одном ряду с ними. */}
      <TrustRow
        managerUrl={config.manager_retail_url}
        onInfo={(hash) => { track("trust_fact_opened", { fact: hash }); navigate(`/info#${hash}`); }}
        onManagerFallback={() => navigate("/info#contacts")}
      />

      {/* ===== Секции товаров: mobile — ленты/сетка 2, desktop — сетка 4 (5 на wide) =====
          Все три секции ниже (Хиты/Сегодня/Рекомендуем) читают один и тот же /catalog/feed —
          при его сбое раньше секции бесконечно показывали скелетон (feed оставался null
          навсегда). Теперь при ошибке — один явный блок с повтором вместо трёх немых. */}

      {/* «Новинки» — первой товарной секцией, выше личной истории (решение
          владельца 25.09.2026): когда приезжает новое устройство, его должно
          быть видно сразу, а не после «Недавно смотрели» и трёх подборок. Секция
          читает тот же /catalog/feed; при его сбое ниже стоит один общий блок
          с повтором, здесь просто ничего не рисуем. */}
      {!feedError && (
        <Section title="Новинки" cards={feed?.new}
          onAll={() => navigate("/catalog")} />
      )}

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
          {/* Секции нет, пока нет ни одного товара в предзаказе: привезли всё —
              раздел пропадает сам, без правки кода и без выключателя. */}
          <Section title="Предзаказ" subtitle="Показали, но ещё не привезли"
            cards={feed?.preorder ?? []}
            onAll={() => {
              const group = feed?.preorder?.[0]?.preorder_group;
              navigate(group ? `/preorder/${encodeURIComponent(group)}` : "/catalog");
            }} />
          <Section title="Хиты продаж" cards={feed?.hot}
            onAll={() => navigate("/catalog")} />
          <Section title="Забрать сегодня" cards={feed?.available_today}
            onAll={() => navigate("/catalog?today=1")} />
        </>
      )}

      {/* Desktop-секции (Скидки/Apple/Gaming) — только lg+, mobile-страницу не
          удлиняем. На телефоне не монтируются вовсе (см. `desktop` выше). */}
      {desktop && (
      <div className="hidden lg:block">
        <Section title="Скидки" cards={extra?.sale}
          onAll={() => navigate("/catalog?category=__sale__")} grid />
        <Section title="Apple" cards={extra?.apple}
          onAll={() => navigate("/catalog")} grid />
        <Section title="Gaming" cards={extra?.gaming}
          onAll={() => navigate(`/catalog?category=${encodeURIComponent("консоли")}`)} grid />
      </div>
      )}

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

      {/* Шторка «Подобрать MacBook» отсюда убрана: её никто не открывал.
          Обработчик openMacbook передавался в ряд услуг пропом, но сам ряд
          пункта «MacBook» не содержал уже давно — то есть путь был мёртв и до
          этой ревизии, просто прятался за живым на вид пропом.
          Сами ScenarioChoiceSheet и MACBOOK_CHOICES не тронуты: это отдельные
          модули со своими тестами, и удалять покрытый код заодно с правкой
          витрины неправильно. Не импортируются — значит, в бандл не попадают. */}
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
/** Прочитать цвет левого края картинки. null — прочитать не удалось.
 *
 *  Canvas «пачкается» чужой картинкой и запрещает getImageData, если сервер не
 *  отдал CORS-заголовки. Для наших загрузок (тот же origin) и для промо из
 *  public это не случается, но администратор может вписать ссылку на чужой
 *  CDN — и тогда чтение бросит исключение. Ловим и возвращаем null: баннер
 *  остаётся на прежнем градиенте, то есть просто не получает улучшения, а не
 *  ломается.
 */
function readSurface(img: HTMLImageElement): { rgb: Rgb; ink: "dark" | "light" } | null {
  try {
    const c = document.createElement("canvas");
    c.width = SURFACE_SAMPLE.width;
    c.height = SURFACE_SAMPLE.height;
    const ctx = c.getContext("2d", { willReadFrequently: false });
    if (!ctx) return null;
    // Рисуем картинку целиком в узкую полоску: нас интересует её левый край,
    // а масштаб по горизонтали как раз и усредняет его по ширине выборки.
    ctx.drawImage(img, 0, 0, SURFACE_SAMPLE.width, SURFACE_SAMPLE.height);
    const rgb = edgeColor(ctx.getImageData(SURFACE_SAMPLE.x, 0, SURFACE_SAMPLE.width, SURFACE_SAMPLE.height).data);
    return rgb ? { rgb, ink: inkOn(rgb) } : null;
  } catch {
    return null;
  }
}

function HeroBanner({
  banner, onOpen, claudeEnabled,
}: {
  banner: HomeBanner;
  onOpen: () => void;
  claudeEnabled: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  // Подложка и цвет текста — из самой фотографии (lib/bannerSurface).
  // Считается один раз на загрузку картинки, не на каждый кадр.
  const [surface, setSurface] = useState<{ rgb: Rgb; ink: "dark" | "light" } | null>(null);
  const curated = curatedPromo(banner);
  const imageSrc = banner.image_url || curated?.src;
  const hasImage = !!imageSrc && !imageFailed;
  const isCurated = !!curated && !banner.image_url;
  // Готовая афиша: макет уже содержит и заголовок, и цену. Накладывать поверх
  // ещё и наши подписи — значит спорить с картинкой, поэтому текст и затемнение
  // не рисуем вовсе, баннер работает как одна большая кнопка. Признак —
  // пустой subtitle у баннера с картинкой: заголовок остаётся для screen reader.
  const artworkOnly = hasImage && !isCurated && !banner.subtitle;
  /** Формат «карточка»: загруженная фотография + наша подпись. Единственный
   *  случай, где текст и снимок делят кадр, — и единственный, где нужна
   *  подложка из самой фотографии. */
  const photoOnSurface = hasImage && !isCurated && !artworkOnly;
  /** Пока цвет не прочитан (первый кадр, сеть, отказ canvas) — текст светлый:
   *  под ним прежний градиент, он тёмный. Так подпись читается всегда, а не
   *  «после того, как картинка доедет». */
  const ink = surface?.ink ?? "light";

  return (
    <button
      onClick={onOpen}
      className={`press-surface lift relative aspect-[3/2] h-auto w-[min(82vw,320px)] shrink-0 snap-start overflow-hidden rounded-hero p-4 text-left lg:aspect-auto lg:h-[184px] lg:w-auto lg:p-5 lg:hover:shadow-[0_18px_40px_-14px_rgba(17,24,39,0.22)] ${
        isCurated
          ? "bg-white text-text shadow-card ring-1 ring-inset ring-black/[0.04]"
          : "shadow-float"
      } ${isCurated || ink === "dark" ? "text-text" : "text-white"}`}
      style={
        isCurated
          ? undefined
          : {
              // Подложка из фотографии, когда она прочитана; иначе прежний
              // градиент. Переход мягкий: цвет приезжает на долю секунды позже
              // картинки, и щелчок заливки был бы заметнее самой заливки.
              background: surface
                ? `rgb(${surface.rgb.join(" ")})`
                : banner.background_gradient || "linear-gradient(135deg,#1a7fd4,#6d5ae0)",
              transition: "background-color 190ms cubic-bezier(0.22,1,0.36,1)",
            }
      }
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
          onLoad={(e) => {
            // Только для формата «карточка»: у готовой афиши и у curated
            // подложка не нужна — первая занимает кадр целиком, вторая лежит
            // на белом по своему макету.
            if (isCurated || artworkOnly) return;
            setSurface(readSurface(e.currentTarget));
          }}
          crossOrigin="anonymous"
          className={photoOnSurface
            ? "absolute inset-y-0 right-0 h-full w-[58%] object-cover"
            : "absolute inset-0 h-full w-full object-cover"}
          style={{ objectPosition: isCurated ? "72% center" : "center" }}
        />
      )}
      {/* Растворение фотографии в подложку вместо затемнения всего кадра.
          Затемнение гасило снимок целиком ради читаемости подписи — то есть
          прятало ровно то, ради чего снимок и ставили. Здесь текст лежит на
          РОВНОМ цвете слева, а фотография начинается там, где текст кончился;
          граница между ними размыта градиентом той же заливки, поэтому шва
          не видно и прямоугольного блока не остаётся. */}
      {photoOnSurface && surface && (
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(to right, rgb(${surface.rgb.join(" ")}) 42%, rgb(${surface.rgb.join(" ")} / 0) 66%)`,
          }}
        />
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
          isCurated || ink === "dark" ? "tracking-[-0.02em] text-text" : "drop-shadow"
        }`}>{banner.title}</p>
        {banner.subtitle && (
          <p className={`mt-1 line-clamp-2 text-[12px] font-medium leading-4 lg:text-[13px] ${
            isCurated || ink === "dark" ? "text-text/60" : "text-white/85 drop-shadow"
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
        // Дуги короче и без «хвостов» наружу: при четырёх штуках в одном
        // глифе прежний вариант нёс вдвое больше чернил, чем соседняя искра,
        // и ряд читался неровным — один вход темнее остальных.
        return <><path d="M4.5 9.5a7.5 7.5 0 0 1 13-3.2" /><path d="M18.5 3v4h-4" /><path d="M19.5 14.5a7.5 7.5 0 0 1-13 3.2" /><path d="M5.5 21v-4h4" /></>;
      case "b2b":
        return <><rect x="3.5" y="7.5" width="17" height="12" rx="2" /><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 12.5h17" /></>;
      case "wholesale":
        return <><path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>;
      case "ai_pick":  // искра — тот же знак, что у кнопки ИИ в поиске
        return <><path d="M12 3.5 13.6 8 18 9.6 13.6 11.2 12 15.7l-1.6-4.5L6 9.6 10.4 8z" /><path d="m18.2 15.4.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" /></>;
      case "marketplace":  // витрина: то, что выставлено на продажу
        return <><path d="M4.5 10V19.5h15V10" /><path d="M3.5 9.5 5.2 5h13.6l1.7 4.5z" /><path d="M10 19.5V15h4v4.5" /></>;
      case "sell_item":  // ценник-бирка
        return <><path d="M11.5 3.5h5.5a2 2 0 0 1 2 2V11l-8.5 8.5-8-8z" /><circle cx="15" cy="8" r="1.2" /></>;
      default: // нейтральный силуэт для незнакомого сценария
        return <><path d="M9.5 3v4.5M14.5 3v4.5" /><rect x="7.5" y="7.5" width="9" height="6" rx="2" /><path d="M12 13.5V18a3 3 0 0 1-3 3" /></>;
    }
  })();
  return (
    // 20px внутри кружка 44px — оптический центр, а не «иконка в рамке». При
    // 24px глиф упирался в края и кружок читался тесным.
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
/** Строка обещаний под афишей.
 *
 *  Не украшение и не «бейджи доверия»: каждый элемент — вход в раздел, где это
 *  обещание расписано. Поэтому у всех троих шеврон — признак, по которому глаз
 *  отличает «нажми» от «прочитай». Без него ряд читался бы как наклейки, и
 *  нажимать бы их не стали.
 *
 *  Горизонтальная прокрутка, а не перенос: перенос на вторую строку удваивает
 *  высоту ради третьего элемента, а ряд обязан оставаться одной строкой — это
 *  сопроводительная информация к афише, а не самостоятельный блок.
 */
function TrustRow({
  managerUrl, onInfo, onManagerFallback,
}: {
  managerUrl?: string;
  onInfo: (hash: string) => void;
  onManagerFallback: () => void;
}) {
  // h-control, а не прежние h-8 (32px): это нажимаемые элементы, и на них
  // распространяется та же норма касания, что на всё остальное. Собственный
  // аудит поймал здесь ровно то, от чего эта строка и должна была уводить, —
  // ещё одну высоту и ещё две толщины обводки.
  const cls =
    "tap flex h-control shrink-0 items-center gap-1.5 whitespace-nowrap rounded-field border border-border " +
    "bg-surface/70 px-3 text-[12px] font-semibold text-text outline-none transition-colors " +
    "hover:border-accent focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <div className="no-scrollbar -mx-4 mt-3 flex items-center gap-2 overflow-x-auto px-4 lg:mx-0 lg:px-0">
      <button className={cls} onClick={() => onInfo("warranty")}>
        <Icon name="shield" className="h-icon w-icon shrink-0 text-accent" />
        Проверка при вас
        <Chevron />
      </button>
      <button className={cls} onClick={() => onInfo("payment")}>
        Оплата после проверки
        <Chevron />
      </button>
      <button
        className={cls}
        onClick={() => {
          track("manager_opened", { source: "home_trust" });
          // Текст подставляется в поле ввода, отправляет человек сам
          // (lib/managerLink). Ссылки нет — уводим в контакты, а не в никуда.
          if (!openExternalLink(managerLink(managerUrl, null))) onManagerFallback();
        }}
      >
        <Icon name="chat" className="h-icon w-icon shrink-0 text-accent" />
        Написать менеджеру
      </button>
    </div>
  );
}

/** Шеврон «здесь откроется». Отдельным узлом, чтобы не повторять svg трижды. */
function Chevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-3 w-3 shrink-0 text-muted"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function QuickScenarios({
  onScenario, onSellItem, onAi, onMarketplace,
}: {
  onScenario: (k: ScenarioKey) => void;
  onSellItem: () => void;
  onAi: () => void;
  onMarketplace: () => void;
}) {
  // Четыре услуги — то, чего на витрине больше нигде нет. Товарных ссылок здесь
  // нет намеренно: каталог живёт отдельной вкладкой внизу, и дублировать её
  // значит соревноваться с собой. Раньше на этом месте стояли две плитки
  // (Trade-In и «Продать») — оставшиеся от четырёх, из которых две адресовались
  // юрлицам и дублировали профиль.
  //
  // «Продать» и «Маркетплейс» стоят рядом и в таком порядке не случайно: это
  // одна дорожка, а не две кнопки. Сдал технику — она появилась на витрине;
  // сосед справа показывает, куда именно она попадёт.
  const items: { key: string; label: string; onClick: () => void }[] = [
    { key: "ai_pick", label: "AI-подбор", onClick: onAi },
    { key: "tradein", label: "Trade-In", onClick: () => onScenario("trade_in") },
    { key: "sell_item", label: "Продать", onClick: onSellItem },
    { key: "marketplace", label: "Маркетплейс", onClick: onMarketplace },
  ];
  return (
    // Сетка на четыре, а не лента. Довод прежний и он не изменился: лента
    // обрезает последний пункт по правому краю — человек видит, что «там ещё
    // что-то есть», но не знает что, и не всякий догадается листать. На 375px
    // четыре колонки дают по 79px при зазоре 8 — «Маркетплейс» помещается.
    // Появится пятая услуга — тогда и решим: лента или вторая строка. Заранее
    // платить обрезом за гипотетический пятый пункт незачем.
    //
    // h-entry (56px) — вторая и последняя высота в системе после control (44).
    // Вход в услугу обязан читаться как другой класс объекта, а не как «кнопка
    // повыше», поэтому разница заметная, а не в пару пикселей.
    <div className="stagger mt-4 grid grid-cols-4 gap-2 lg:hidden">
      {items.map((s) => (
        <button
          key={s.key}
          ref={enterGridRefCallback("fadeUp")}
          onClick={s.onClick}
          className="tap flex min-w-0 flex-col items-center gap-[7px] text-center"
        >
          {/* Кружок, а не плашка во всю плитку. Плашка 79×56 с радиусом 20 —
              это почти скруглённый квадрат без границы, и читался он как
              незагруженный блок. Кружок — правильная фигура: он одинаков у всех
              четырёх, и ряд перестаёт быть набором разных прямоугольников.

              АКЦЕНТ ТОЛЬКО У AI-ПОДБОРА. Индиго — цвет главного действия, и
              когда им выкрашены все четыре неактивных входа, он не помечает
              ничего. Оставив его ровно на одном, возвращаем ему работу: по ряду
              сразу видно, что здесь главное. Остальные три — нейтральные. */}
          <span
            className={
              s.key === "ai_pick"
                ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/[0.11] text-accent"
                : "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mutedbg text-text/75"
            }
          >
            <ScenarioIcon name={s.key} />
          </span>
          {/* 11px обычным, а не 10.5 жирным. Мелкий жирный шрифт даёт кашу
              вместо букв — это и был самый заметный признак дешевизны ряда. */}
          <span className="line-clamp-1 block max-w-full text-[11px] font-medium leading-[1.1] tracking-[0.005em] text-text">{s.label}</span>
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
