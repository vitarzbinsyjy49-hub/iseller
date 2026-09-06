/** Ref-колбэки для animateEnter (lib/motion.ts) — вешают проявление на
 *  СУЩЕСТВУЮЩИЙ элемент, без обёртки в лишний div (в отличие от
 *  components/onboarding/Appear.tsx, который рендерит свой контейнер — там
 *  это нормально, здесь обёртка сломала бы grid/flex-разметку карточек).
 *
 *  Ref-колбэк, а не хук на useLayoutEffect(…, []): элементы этого модуля
 *  почти всегда УСЛОВНО отрисовываются (`{cond && <div .../>}`,
 *  `if (!x) return null` в самом компоненте) — сам компонент при этом не
 *  пересоздаётся, React лишь переключает его вывод между null и JSX, и хук с
 *  пустыми deps отработал бы только на первом рендере компонента, когда
 *  условие почти наверняка ещё не выполнено (эффект увидел бы `ref.current
 *  === null` и тихо вышел, что и произошло в первой версии этого файла —
 *  панель корзины и блок «на домашний экран» из-за этого не проигрывали
 *  появление вовсе). Ref-колбэк free от этой проблемы: React вызывает его
 *  ровно тогда, когда узел реально появляется в DOM, сколько бы раз компонент
 *  ни переключался между null и содержимым. */
import { animateEnter, staggerDelayMs, type EnterPreset } from "./motion";

/** Флаг на самом DOM-узле не даёт колбэку переиграть анимацию: инлайновый
 *  ref-колбэк в JSX — новая функция на каждый рендер, и React из-за этого
 *  вызывает его заново (null, потом узел) при любом ре-рендере, пока сам узел
 *  остаётся смонтированным; без флага анимация проигрывалась бы при каждом
 *  ре-рендере родителя, а не один раз при настоящем появлении.
 *
 *  delayMs — замена `.stagger` (index.css) для случаев, где индекс уже под
 *  рукой; для списков карточек обычно проще enterGridRefCallback ниже. */
export function enterRefCallback(preset: EnterPreset, delayMs = 0, dxPx = 0) {
  return (el: HTMLElement | null) => {
    if (!el || el.dataset.entered) return;
    el.dataset.entered = "1";
    animateEnter(el, preset, undefined, delayMs, dxPx);
  };
}

/** Как enterRefCallback, но задержку не передают явно — берут её из позиции
 *  элемента среди DOM-соседей. Раньше это делал CSS `.stagger > *:nth-child()`
 *  (index.css) — тоже считал позицию в DOM, а не индекс React-списка, поэтому
 *  подходит и для переиспользуемых карточек, которые сам свой индекс не
 *  знают: ProductCard вызывается из 9 разных мест (Home/Catalog/Cart/...),
 *  пробрасывать туда index в каждое было бы избыточно ради того, что и так
 *  лежит в DOM к моменту монтирования (React вставляет весь список одним
 *  коммитом раньше, чем срабатывает любой из его ref-колбэков). */
export function enterGridRefCallback(preset: EnterPreset) {
  return (el: HTMLElement | null) => {
    if (!el || el.dataset.entered) return;
    el.dataset.entered = "1";
    const siblingIndex = el.parentElement
      ? Array.prototype.indexOf.call(el.parentElement.children, el)
      : 0;
    animateEnter(el, preset, undefined, staggerDelayMs(Math.max(0, siblingIndex)));
  };
}
