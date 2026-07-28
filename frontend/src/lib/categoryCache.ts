/** Кэш категорий каталога — ТОЛЬКО localStorage, для мгновенной отрисовки.
 *
 *  Зачем: hero-чипы и боковое меню нужно показать сразу, до ответа
 *  /catalog/categories, иначе при загрузке прыгает вёрстка. Раньше для этого
 *  использовался захардкоженный список категорий — он разъехался с базой, и
 *  пользователь видел плитки «Dyson» и «Аксессуары», которых в каталоге нет:
 *  нажатие вело в пустой экран.
 *
 *  Теперь мгновенно показывается последний РЕАЛЬНЫЙ ответ сервера. Устареть он
 *  может максимум на один визит: пришёл свежий список — кэш перезаписан. Новая
 *  категория из админки появляется сама, исчезнувшая — пропадает.
 *
 *  Чистые функции (parse/serialize) отделены от localStorage-обвязки, чтобы
 *  тестироваться в node без DOM — как searchHistory и viewport.
 */

export type NavCategory = { key: string; label: string; icon: string; count: number };

const KEY = "aiseller_catalog_categories_v1";
/** Больше показать всё равно некуда (hero режет до 6), а localStorage не резиновый. */
const LIMIT = 24;

/** Чистая функция: оставить только записи, пригодные для навигации.
 *  Категория без ключа некликабельна, с нулевым счётчиком — ведёт в пустоту;
 *  ни ту, ни другую в кэш не пускаем, даже если сервер такое пришлёт. */
export function sanitizeCategories(raw: unknown): NavCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: NavCategory[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const key = typeof c.key === "string" ? c.key.trim() : "";
    const label = typeof c.label === "string" ? c.label.trim() : "";
    const count = typeof c.count === "number" ? c.count : 0;
    if (!key || !label || count <= 0 || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label, icon: typeof c.icon === "string" ? c.icon : "🛍️", count });
    if (out.length >= LIMIT) break;
  }
  return out;
}

/** Последний известный список. Пусто/битый JSON => [], без исключений наружу:
 *  кэш — ускорение, его отказ не должен ломать главную. */
export function loadCachedCategories(): NavCategory[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitizeCategories(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveCachedCategories(cats: unknown): void {
  try {
    const clean = sanitizeCategories(cats);
    if (clean.length) localStorage.setItem(KEY, JSON.stringify(clean));
    else localStorage.removeItem(KEY);   // каталог опустел — не показываем старое
  } catch {
    /* приватный режим/переполнение — молча живём без кэша */
  }
}
