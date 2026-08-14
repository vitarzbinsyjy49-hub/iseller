import { withStaleChunkReload } from "./staleChunk";

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
  profile: withStaleChunkReload(() => import("../pages/Profile")),
  loyalty: withStaleChunkReload(() => import("../pages/Loyalty")),
  info: withStaleChunkReload(() => import("../pages/Info")),
  scenarioChat: withStaleChunkReload(() => import("../pages/ScenarioChat")),
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
  return null;
}

/** Запускает фоновую загрузку экрана и никогда не ломает само нажатие. */
export function preloadRoute(pathname: string): void {
  const key = routeKey(pathname);
  if (!key || started.has(key)) return;
  started.add(key);
  void routeLoaders[key]().catch(() => {
    // Сетевой сбой не должен навсегда запрещать повторную попытку через lazy().
    started.delete(key);
  });
}
