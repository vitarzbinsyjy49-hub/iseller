/** Единая точка решения про движение в интерфейсе.
 *
 *  Зачем модуль. Настройка «уменьшить движение» решалась в шести местах
 *  независимо, и четыре из них отвечали одинаково неверно: «тогда не делаем
 *  ничего». Так интерфейс терял не анимацию, а обратную связь — человек
 *  переставал понимать, что вообще произошло. Симптом при этом каждый раз
 *  выглядел как отдельная поломка отдельной фичи («лента не листается», «шит
 *  открывается рывком»), и связь между ними была не видна.
 *
 *  Правило одно: «убрать движение» — это НЕ «убрать событие». Поэтому здесь нет
 *  и не может быть варианта «ничего»: `transitionStyle` отдаёт либо движение,
 *  либо затухание. Прежнее правило жило в комментариях, и каждая новая фича
 *  решала заново — этот модуль делает его механизмом.
 *
 *  Читать настройку напрямую через matchMedia в компонентах больше не нужно:
 *  всё, что от неё зависит, спрашивает здесь.
 */

/** Как показать смену состояния. `none` отсутствует намеренно, см. выше. */
export type TransitionStyle = "move" | "fade";

/** Длительность затухания — замены движению. Короче, чем сам сдвиг: затухание
 *  не несёт информации о направлении, и растягивать его незачем. */
export const FADE_MS = 160;

/** Включена ли у пользователя «уменьшить движение».
 *
 *  Читается на каждый вызов, а не один раз при загрузке: настройку меняют прямо
 *  во время работы (в iOS это переключатель в шторке), и закэшированное значение
 *  означало бы, что до перезапуска приложения оно игнорируется.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Чем показывать смену состояния при текущих настройках. */
export function transitionStyle(reducedMotion = prefersReducedMotion()): TransitionStyle {
  return reducedMotion ? "fade" : "move";
}

/** Длительность перехода: при «уменьшить движение» — время затухания, иначе
 *  переданная длительность движения. Ноль не отдаём никогда: мгновенная подмена
 *  и есть то самое «ничего», от которого мы уходим. */
export function transitionDuration(moveMs: number, reducedMotion = prefersReducedMotion()): number {
  return reducedMotion ? FADE_MS : moveMs;
}

// ===== Собственная анимация горизонтальной прокрутки =====

/** Кривая движения: быстрый старт, мягкое торможение (ease-out-quint).
 *  Та же линия, что у --ease-standard в index.css. */
export function easeOutQuint(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 5);
}

/** Позиция прокрутки на момент времени: чистая функция, тестируется без DOM. */
export function scrollPositionAt(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return to;
  return from + (to - from) * easeOutQuint(elapsedMs / durationMs);
}

/** Плавно прокрутить ленту к позиции СВОЕЙ анимацией, а не браузерной.
 *
 *  Почему не `scrollTo({behavior: 'smooth'})`, хотя он короче: браузерный
 *  плавный скролл рисует композитор, и в части окружений (WebView, скрытая
 *  вкладка, часть Android-прошивок) он молча не срабатывает — прокрутка
 *  происходит, но мгновенно. Отладить это со стороны кода нельзя: ошибки нет,
 *  событий нет, отличить «не анимировалось» от «анимировалось быстро» нечем.
 *  Своя анимация ведёт себя одинаково везде и не зависит от чужих решений.
 *
 *  Возвращает функцию отмены — её обязан вызвать тот, кто владеет элементом.
 */
export function animateScrollTo(el: HTMLElement, left: number, durationMs: number): () => void {
  const from = el.scrollLeft;
  if (durationMs <= 0 || Math.abs(left - from) < 1) {
    el.scrollLeft = left;
    return () => {};
  }

  // Снимаем защёлкивание на время анимации и возвращаем в конце.
  //
  // Без этого анимации просто нет: у ленты `scroll-snap-type: x mandatory`, и
  // браузер защёлкивает КАЖДЫЙ промежуточный кадр к ближайшей точке — вместо
  // проезда получается прыжок. Замер на живой странице: за 620мс анимации одна
  // промежуточная позиция вместо пятнадцати. Возвращать безопасно: целевая
  // позиция сама является точкой привязки, так что защёлкивать нечего.
  const snapBefore = el.style.scrollSnapType;
  el.style.scrollSnapType = "none";
  const restoreSnap = () => { el.style.scrollSnapType = snapBefore; };

  const start = performance.now();
  let frame = 0;

  const step = (now: number) => {
    const elapsed = now - start;
    if (elapsed >= durationMs) {
      el.scrollLeft = left;
      restoreSnap();
      return;
    }
    el.scrollLeft = scrollPositionAt(from, left, elapsed, durationMs);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);

  return () => { cancelAnimationFrame(frame); restoreSnap(); };
}
