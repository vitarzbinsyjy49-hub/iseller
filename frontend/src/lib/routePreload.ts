/**
 * Единые загрузчики экранов: React.lazy использует их при навигации, а ссылки
 * могут начать загрузку уже на pointerdown/hover. Повторный import безопасен —
 * модульный загрузчик браузера дедуплицирует один и тот же chunk.
 */
export const routeLoaders = {
  catalog: () => import("../pages/Catalog"),
  product: () => import("../pages/ProductDetails"),
  ai: () => import("../pages/AiSearch"),
  requests: () => import("../pages/Requests"),
  cart: () => import("../pages/Cart"),
  favorites: () => import("../pages/Favorites"),
  history: () => import("../pages/History"),
  profile: () => import("../pages/Profile"),
  loyalty: () => import("../pages/Loyalty"),
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
