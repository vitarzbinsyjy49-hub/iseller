import { withStaleChunkReload } from "./staleChunk";
import { prefetchApi, SHOP } from "./apiCache";

/**
 * Единые загрузчики экранов: React.lazy использует их при навигации, а ссылки
 * могут начать загрузку уже на pointerdown/hover. Повторный import безопасен —
 * модульный загрузчик браузера дедуплицирует один и тот же chunk.
 *
 * Каждый загрузчик обёрнут в withStaleChunkReload: приложение, открытое до
 * деплоя, идёт за chunk'ом со старым хэшем в имени, которого на сервере уже
 * нет, и вместо экрана ошибки один раз перезагружается. Обёртка живёт здесь,
 * потому что это единственное место, через которое проходят ВСЕ ленивые
 * загрузки — и React.lazy, и preloadRoute ниже.
 */
export const routeLoaders = {
  catalog: withStaleChunkReload(() => import("../pages/Catalog")),
  product: withStaleChunkReload(() => import("../pages/ProductDetails")),
  ai: withStaleChunkReload(() => import("../pages/AiSearch")),
  requests: withStaleChunkReload(() => import("../pages/Requests")),
  cart: withStaleChunkReload(() => import("../pages/Cart")),
  favorites: withStaleChunkReload(() => import("../pages/Favorites")),
  history: withStaleChunkReload(() => import("../pages/History")),
  reviewForm: withStaleChunkReload(() => import("../pages/ReviewForm")),
  profile: withStaleChunkReload(() => import("../pages/Profile")),
  loyalty: withStaleChunkReload(() => import("../pages/Loyalty")),
  info: withStaleChunkReload(() => import("../pages/Info")),
  scenarioChat: withStaleChunkReload(() => import("../pages/ScenarioChat")),
  sellItem: withStaleChunkReload(() => import("../pages/SellItem")),
  marketplace: withStaleChunkReload(() => import("../pages/Marketplace")),
  preorder: withStaleChunkReload(() => import("../pages/Preorder")),
};

const started = new Set<keyof typeof routeLoaders>();

function routeKey(pathname: string): keyof typeof routeLoaders | null {
  if (pathname.startsWith("/product/") || pathname === "/product") return "product";
  if (pathname.startsWith("/catalog")) return "catalog";
  if (pathname.startsWith("/ai")) return "ai";
  if (pathname.startsWith("/requests")) return "requests";
  if (pathname.startsWith("/cart")) return "cart";
  if (pathname.startsWith("/favorites")) return "favorites";
  if (pathname.startsWith("/history")) return "history";
  if (pathname.startsWith("/profile")) return "profile";
  if (pathname.startsWith("/loyalty")) return "loyalty";
  if (pathname.startsWith("/info")) return "info";
  if (pathname.startsWith("/apply/")) return "scenarioChat";
  if (pathname.startsWith("/sell")) return "sellItem";
  if (pathname.startsWith("/marketplace")) return "marketplace";
  if (pathname.startsWith("/preorder/")) return "preorder";
  return null;
}

/** Данные, которые экран запросит первым делом, — прогреваются вместе с его
 *  кодом. Код без данных ускорял только половину дела: чанк уже разобран, а
 *  экран всё равно стоит со скелетоном и ждёт сеть. Здесь перечислены ровно те
 *  запросы, БЕЗ которых экран показать нечего; всё остальное (личное,
 *  второстепенное) грузится уже на самом экране и в прогреве не участвует.
 *
 *  Пути берутся из общих литералов SHOP (lib/apiCache) — теми же самыми
 *  пользуется экран. Совпадать они обязаны символ в символ: ключ кэша — это
 *  сам путь, и разойдись строки, обе стороны продолжат работать, просто без
 *  ускорения. Списка нет у карточки товара (путь зависит от id — см.
 *  preloadProduct ниже), а у каталога перечислены только ряд категорий и
 *  брендов: сам список товаров собирается из фильтров в URL.
 *
 *  Главная лежит здесь же, хотя её код в стартовом чанке и грузить его не
 *  надо: прогревать её данные всё равно есть кому — старт приложения (см.
 *  warmRouteData). */
export const WARM_DATA: Record<string, readonly string[]> = {
  home: [SHOP.home, SHOP.feed, SHOP.categories],
  catalog: [SHOP.categories, SHOP.brands],
};

/** Ключ прогрева данных. Отличается от routeKey ровно одним: у главной кода
 *  для ленивой загрузки нет, а данные есть. */
function warmKey(pathname: string): string | null {
  if (pathname === "/") return "home";
  return routeKey(pathname);
}

/** Запустить запросы, без которых экран нечего показывать.
 *
 *  Вызывается двумя разными людьми и по двум разным поводам: нажатием на
 *  ссылку (ниже, вместе с кодом экрана) и стартом приложения, сразу как
 *  появился токен (App.tsx). Второе важнее первого: до этой правки витрина
 *  ждала не только авторизацию, но и ответ /users/me после неё, потому что
 *  экран вообще не монтировался, пока идёт вход. Теперь запросы витрины уходят
 *  сразу за токеном, параллельно с /users/me, и к монтированию главной ответ
 *  чаще всего уже здесь. */
export function warmRouteData(pathname: string): void {
  const key = warmKey(pathname);
  if (!key) return;
  for (const path of WARM_DATA[key] ?? []) prefetchApi(path);
}

/** Запускает фоновую загрузку экрана и никогда не ломает само нажатие.
 *
 *  Греется и код, и данные. Момент один и тот же — `pointerdown`, то есть
 *  примерно за 100-200мс до того, как палец оторвётся и произойдёт переход:
 *  ровно столько, чтобы запрос успел уйти, пока человек ещё не отпустил
 *  экран. */
export function preloadRoute(pathname: string): void {
  const key = routeKey(pathname);
  if (!key) return;
  // Данные греем на КАЖДОМ нажатии, а код — один раз. Ответ успевает
  // устареть между заходами (минута, см. lib/apiCache), модуль — нет; общая
  // защёлка означала бы, что со второго раза экран снова ждёт сеть.
  // Повторный прогрев свежего ответа ничего не стоит: react-query видит, что
  // данные ещё годны, и в сеть не идёт.
  warmRouteData(pathname);
  if (started.has(key)) return;
  started.add(key);
  void routeLoaders[key]().catch(() => {
    // Сетевой сбой не должен навсегда запрещать повторную попытку через lazy().
    started.delete(key);
  });
}

/** Прогрев КАРТОЧКИ товара: её код общий на все товары, а данные у каждого
 *  свои, и в общий список выше их не занести — путь зависит от id. Это самый
 *  частый переход в приложении (плитка витрины), поэтому он и вынесен
 *  отдельной функцией, а не оставлен вызывающим на усмотрение. */
export function preloadProduct(id: number): void {
  preloadRoute("/product");
  prefetchApi(`/catalog/product/${id}`);
}
