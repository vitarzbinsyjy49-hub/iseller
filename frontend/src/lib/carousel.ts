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

// ===== Автопрокрутка ленты баннеров на главной =====

/** Пауза после жеста пользователя, прежде чем лента снова поедет сама. */
export const AUTOPLAY_RESUME_MS = 9_000;

/** Шаг автопрокрутки: следующий слайд, с последнего — на первый. */
export function nextSlideIndex(current: number, count: number): number {
  if (count <= 1) return 0;
  return (current + 1) % count;
}

/** Можно ли сейчас пролистнуть ленту самим.
 *
 *  Четыре причины НЕ листать, и каждая из них — про уважение к пользователю:
 *  - он только что сам листал: перехватывать управление сразу после жеста
 *    противно, поэтому ждём `AUTOPLAY_RESUME_MS`;
 *  - вкладка/приложение скрыты: иначе накопится десяток тиков и на возврате
 *    лента прыгнет через все баннеры разом;
 *  - листать нечего: на desktop это сетка, а не лента, и при одном баннере
 *    прокрутка бессмысленна.
 *
 *  Здесь намеренно НЕТ проверки prefers-reduced-motion: эта настройка убирает
 *  движение, а не жизнь интерфейса (см. блок reduce в index.css). При ней лента
 *  всё так же меняет баннер, просто другим переходом — см. slideTransition.
 */
export function autoplayReady(state: {
  now: number;
  lastInteractionAt: number;
  visible: boolean;
  scrollable: boolean;
}): boolean {
  if (!state.visible || !state.scrollable) return false;
  return state.now - state.lastInteractionAt >= AUTOPLAY_RESUME_MS;
}

// Каким переходом менять баннер, решает lib/motion (transitionStyle) — там же,
// где это решают все остальные анимации проекта. Здесь этого правила нет
// намеренно: пока оно жило по месту, каждая новая фича решала заново.

/** Куда прокрутить ленту, чтобы слайд встал ровно в свою точку привязки.
 *
 *  Вычитать `scrollPaddingLeft` обязательно. У ленты задан `scroll-px-4`, то
 *  есть отступ прокрутки 16px, и точка привязки сдвинута на него: слайд
 *  выравнивается не по краю ленты, а по краю её «окна привязки». Без вычитания
 *  анимация приезжала на 16 пикселей дальше, а при возврате защёлкивания
 *  браузер утягивал ленту назад — глазом это читалось как «проехал и вернулся».
 *
 *  Зажим по краям нужен для крайних слайдов: у последнего расчётная позиция
 *  выходит за предел прокрутки, и без зажима получался бы тот же откат.
 */
export function snapTargetLeft(geometry: {
  slideOffsetLeft: number;
  stripOffsetLeft: number;
  scrollPaddingLeft: number;
  maxScrollLeft: number;
}): number {
  const raw = geometry.slideOffsetLeft - geometry.stripOffsetLeft - geometry.scrollPaddingLeft;
  return Math.max(0, Math.min(raw, Math.max(0, geometry.maxScrollLeft)));
}
