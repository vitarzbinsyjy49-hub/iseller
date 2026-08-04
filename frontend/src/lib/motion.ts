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

// ===== Собственные анимации =====
//
// Всё, что здесь есть, рисуется из JS через requestAnimationFrame, и это не
// вкусовщина. На части устройств система гасит ВСЮ декларативную анимацию
// разом: CSS-переходы, CSS-анимации, Web Animations API и браузерный плавный
// скролл (на Android это «Убрать анимации» / нулевой animator duration scale).
// Свойство при этом применяется мгновенно — ошибки нет, события есть, отличить
// «не анимировалось» от «анимировалось быстро» со стороны кода нечем. Проверено
// на живом телефоне: набор текста в AI (он на JS) шёл плавно, а затухание
// баннера на CSS-переходе выглядело щелчком.
//
// Поэтому правило: если анимацию должен увидеть пользователь — она считается
// здесь, а не отдаётся браузеру.

/** Кривая движения: быстрый старт, мягкое торможение (ease-out-quint).
 *  Та же линия, что у --ease-standard в index.css. */
export function easeOutQuint(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 5);
}

/** Значение на момент времени: чистая функция, тестируется без DOM. Годится и
 *  для позиции прокрутки, и для прозрачности — кривая одна. */
export function scrollPositionAt(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return to;
  return from + (to - from) * easeOutQuint(elapsedMs / durationMs);
}

/** Прогнать значение от `from` к `to` за `durationMs`, отдавая каждый кадр в
 *  `apply`. Общий мотор для прокрутки и прозрачности. Возвращает отмену. */
function animateValue(
  from: number, to: number, durationMs: number,
  apply: (value: number) => void,
  done?: () => void,
): () => void {
  if (durationMs <= 0) {
    apply(to);
    done?.();
    return () => {};
  }

  const start = performance.now();
  let frame = 0;

  const step = (now: number) => {
    const elapsed = now - start;
    if (elapsed >= durationMs) {
      apply(to);
      done?.();
      return;
    }
    apply(scrollPositionAt(from, to, elapsed, durationMs));
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);

  return () => cancelAnimationFrame(frame);
}

/** Прогнать произвольное число от `from` к `to` своими кадрами.
 *
 *  Тот же мотор, что у прокрутки и прозрачности, но без привязки к свойству:
 *  им пользуется блик легендарной карточки, который двигает не scroll и не
 *  opacity, а собственную позицию градиента. Возвращает отмену. */
export function animateNumber(
  from: number, to: number, durationMs: number,
  apply: (value: number) => void,
  done?: () => void,
): () => void {
  return animateValue(from, to, durationMs, apply, done);
}

/** Плавно изменить прозрачность элемента — своими руками, без CSS-перехода.
 *
 *  CSS-переход здесь не годится: на устройствах с выключенной системной
 *  анимацией он применяется мгновенно, и затухание выглядит щелчком. Именно так
 *  и выглядела смена баннера на проде.
 */
export function animateOpacity(el: HTMLElement, from: number, to: number, durationMs: number, done?: () => void): () => void {
  // Инлайновый transition убираем: если он остался от прежнего кода, браузер
  // попытается доводить значение сам поверх наших кадров.
  el.style.transition = "";
  return animateValue(from, to, durationMs, (v) => { el.style.opacity = String(v); }, done);
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
/** Прокрутка своими кадрами. Внутренняя: снаружи вызывают animateScrollTo. */
function animateScrollOurselves(el: HTMLElement, from: number, left: number, durationMs: number): () => void {
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

  const cancel = animateValue(from, left, durationMs, (v) => { el.scrollLeft = v; }, restoreSnap);
  return () => { cancel(); restoreSnap(); };
}

/** Сколько ждём, прежде чем решить, что браузер плавность проигнорировал.
 *  Два-три кадра: за это время настоящая анимация успевает сдвинуться. */
const SMOOTH_PROBE_MS = 50;

/** Плавно прокрутить ленту к позиции.
 *
 *  Сначала просим браузер (`behavior: 'smooth'`), и это не лень: браузерную
 *  прокрутку рисует композитор — та же дорожка, по которой лента едет под
 *  пальцем, с тем же качеством и без нагрузки на основной поток. Своими
 *  кадрами так гладко не получится, они считаются в JS.
 *
 *  Но композитор берёт эту работу не всегда: при системном «уменьшить
 *  движение» браузер выполняет плавную прокрутку мгновенно, и в части WebView
 *  она игнорируется молча. Поэтому через пару кадров проверяем, тронулась ли
 *  лента, и если нет — дорисовываем сами. Проверка безопасна: если браузер
 *  проигнорировал плавность, позиция ещё равна исходной, и подхват не даёт
 *  скачка.
 *
 *  Возвращает функцию отмены — её обязан вызвать тот, кто владеет элементом.
 */
export function animateScrollTo(el: HTMLElement, left: number, durationMs: number): () => void {
  const from = el.scrollLeft;
  if (durationMs <= 0 || Math.abs(left - from) < 1) {
    el.scrollLeft = left;
    return () => {};
  }

  // Решаем ДО обращения к браузеру, а не по факту. Проверить постфактум
  // нельзя: при «уменьшить движение» браузер выполняет плавную прокрутку
  // мгновенно, и для любой пробы это неотличимо от «уже доехали» — позиция
  // равна целевой в обоих случаях. Замер это и показал: проба видела прыжок на
  // 320 пикселей и делала вывод, что анимация идёт.
  if (typeof el.scrollTo !== "function" || prefersReducedMotion()) {
    return animateScrollOurselves(el, from, left, durationMs);
  }

  let cancelSelf = () => {};
  el.scrollTo({ left, behavior: "smooth" });

  // Подстраховка для окружений, которые игнорируют плавность молча и БЕЗ
  // всякой настройки: если через пару кадров лента не сдвинулась ни на пиксель,
  // дорисовываем сами. Скачка тут быть не может — позиция ещё исходная.
  const probe = window.setTimeout(() => {
    if (Math.abs(el.scrollLeft - from) < 1) {
      cancelSelf = animateScrollOurselves(el, el.scrollLeft, left, durationMs);
    }
  }, SMOOTH_PROBE_MS);

  return () => { window.clearTimeout(probe); cancelSelf(); };
}
