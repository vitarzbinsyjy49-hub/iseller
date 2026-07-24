/** Чистая логика карусели карточки (v5.4.0) — тестируется без DOM.
 *
 *  Разделяет жест на «тап» (открыть товар), «листание» (сменить слайд) и «ничего»
 *  (недостаточно для листания — просто вернуть на место, БЕЗ открытия товара).
 *  Именно это отделяет горизонтальный свайп от обычного тапа и от вертикального
 *  скролла страницы.
 */

export type SwipeResult = "tap" | "prev" | "next" | "none";

export const TAP_SLOP = 8;          // движение <= TAP_SLOP по обеим осям = тап

/** Классифицировать завершённый жест. dx/dy — смещение от точки нажатия,
 *  width — ширина области (для порога листания). */
export function classifySwipe(
  dx: number, dy: number, width: number, tap: number = TAP_SLOP,
): SwipeResult {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx <= tap && ady <= tap) return "tap";
  // Листаем только при явно горизонтальном намерении и достаточном размахе.
  const threshold = Math.max(36, width * 0.2);
  if (adx > ady && adx >= threshold) return dx < 0 ? "next" : "prev";
  return "none";
}

/** Новый индекс после жеста (с зажимом в границы, без зацикливания). */
export function nextIndex(index: number, result: SwipeResult, count: number): number {
  if (count <= 0) return 0;
  if (result === "next") return Math.min(index + 1, count - 1);
  if (result === "prev") return Math.max(index - 1, 0);
  return index;
}

/** Жест сдвинулся достаточно, чтобы подавить синтетический click (не открывать
 *  товар после свайпа). */
export function movedBeyondTap(dx: number, dy: number, tap: number = TAP_SLOP): boolean {
  return Math.abs(dx) > tap || Math.abs(dy) > tap;
}

/** Какие слайды реально монтировать (активный ± соседи) — чтобы не грузить все
 *  10 изображений каждой карточки разом. */
export function isSlideMounted(slideIndex: number, activeIndex: number): boolean {
  return Math.abs(slideIndex - activeIndex) <= 1;
}

/** Индекс из позиции скролла (для scroll-snap галерей, напр. ProductDetails). */
export function indexFromScroll(scrollLeft: number, slideWidth: number, count: number): number {
  if (slideWidth <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(scrollLeft / slideWidth)));
}
