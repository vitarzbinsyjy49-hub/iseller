/** Режим строки поиска: обычный поиск по каталогу или AI-подбор.
 *
 *  Логика маршрута вынесена в чистую функцию не ради красоты: одинаковый
 *  обработчик Enter продублирован в Home, Catalog и DesktopHeader, и четвёртая
 *  копия — уже с двумя режимами — разъехалась бы с остальными. Плюс тестируется
 *  в node без DOM, как searchHistory и categoryCache.
 */
export type SearchMode = "catalog" | "ai";

export function searchRoute(mode: SearchMode, query: string): string {
  const q = query.trim();
  if (mode === "ai") return q ? `/ai?q=${encodeURIComponent(q)}` : "/ai";
  return q ? `/catalog?query=${encodeURIComponent(q)}` : "/catalog";
}
