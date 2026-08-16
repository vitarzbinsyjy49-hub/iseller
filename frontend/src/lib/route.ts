/** Защита навигации от подмены адреса данными из API (v5.4.2).
 *
 * Маршруты баннеров/категорий приходят из админки. Даже если админка окажется
 * скомпрометирована (или в данные попадёт мусор), переход не должен уводить
 * пользователя на чужой сайт и тем более исполнять `javascript:`.
 *
 * Это же закрывает практическую поверхность advisory react-router об open
 * redirect через backslash: сюда попадает всё, что не является внутренним путём.
 */

const SAFE_FALLBACK = "/catalog";

/** Внутренний путь приложения: начинается с одного `/`, без схемы и хоста. */
export function safeInternalRoute(to: unknown, fallback: string = SAFE_FALLBACK): string {
  if (typeof to !== "string") return fallback;
  const v = to.trim();
  if (!v) return fallback;
  // backslash эквивалентен слэшу в браузерах: `\\evil.com` и `/\evil.com` уводят наружу
  const normalized = v.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) return fallback;   // относительный или схема (http:, javascript:)
  if (normalized.startsWith("//")) return fallback;   // protocol-relative -> внешний хост
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(normalized)) return fallback;  // "/javascript:..." и подобное
  return normalized;
}

/** Куда ведёт клик по баннеру/плитке главной (общая маршрутизация action-ов).
 *
 * Значения приходят из админки, поэтому результат проходит через
 * safeInternalRoute: наружу увести переходом нельзя.
 *
 * Живёт здесь, а не в Home: маршрут нужен и навигации главной (navTiles), и
 * самой странице, а как чистая функция он ещё и проверяется тестами. */
export function actionRoute(type: string, value?: string | null): string {
  const v = (value ?? "").trim();
  switch (type) {
    case "category": return `/catalog?category=${encodeURIComponent(v)}`;
    // brand: «Dyson» — это бренд, а не категория (его товары лежат в «красота»
    // и «бытовая техника»), поэтому плитка по категории вела в пустоту.
    case "brand": return `/catalog?brand=${encodeURIComponent(v)}`;
    case "search": return `/catalog?query=${encodeURIComponent(v)}`;
    case "product": return safeInternalRoute(`/product/${encodeURIComponent(v)}`);
    case "collection": return `/catalog?collection=${encodeURIComponent(v)}`;
    case "ai": return v ? `/ai?q=${encodeURIComponent(v)}` : "/ai";
    // sell_item — подать заявку «Предложить товар»; marketplace — витрина
    // уже одобренных пользовательских товаров (два разных места, см.
    // docs/superpowers/specs/2026-08-15-marketplace-used-items-design.md).
    case "sell_item": return "/sell";
    case "marketplace": return "/marketplace";
    default: return "/catalog";
  }
}


/** Разрешённые схемы для ВНЕШНИХ ссылок баннеров (остальное — не открываем).
 * Разбираем без base: внешняя ссылка обязана быть абсолютной http/https. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const v = url.trim();
  if (!v) return null;
  try {
    const parsed = new URL(v);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
