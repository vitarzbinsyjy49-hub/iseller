/** Чистая логика каруселей фото (v5.5.0) — тестируется без DOM.
 *
 *  Само листание и в карточке, и на странице товара делает нативный
 *  горизонтальный scroll-snap, поэтому здесь остаётся только то, что браузер за
 *  нас не решает: отличить тап (открыть товар) от листания, посчитать активный
 *  индекс по позиции скролла и решить, какие слайды вообще монтировать.
 *
 *  До v5.5.0 карточка листалась вручную (жест разбирался в JS, слайды двигались
 *  трансформом на каждый pointermove) — отсюда были функции классификации
 *  свайпа по размаху; вместе с ручным листанием они и ушли.
 */

export const TAP_SLOP = 8;          // движение <= TAP_SLOP по обеим осям = тап

/** Какие слайды реально монтировать (активный ± соседи) — чтобы не грузить все
 *  10 изображений каждой карточки разом. */
export function isSlideMounted(slideIndex: number, activeIndex: number): boolean {
  return Math.abs(slideIndex - activeIndex) <= 1;
}

/** Тап ли это по слайду (открыть товар) — для каруселей на нативном scroll-snap.
 *
 *  В нативной карусели листание делает браузер, а не наш код: pointermove во
 *  время скролла может вообще не приходить (браузер забирает указатель и шлёт
 *  pointercancel). Поэтому «был ли жест» определяем по двум признакам сразу:
 *  смещение пальца И фактический сдвиг scrollLeft за время жеста. Любой из них
 *  выше порога — это листание, товар не открываем.
 */
export function isTapGesture(
  dx: number, dy: number, scrollDelta: number, tap: number = TAP_SLOP,
): boolean {
  return Math.abs(dx) <= tap && Math.abs(dy) <= tap && Math.abs(scrollDelta) <= 1;
}

/** Индекс из позиции скролла (для scroll-snap галерей, напр. ProductDetails). */
export function indexFromScroll(scrollLeft: number, slideWidth: number, count: number): number {
  if (slideWidth <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(scrollLeft / slideWidth)));
}
