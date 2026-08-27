/** Панель инструментов каталога, которая уходит с экрана при прокрутке вниз и
 *  возвращается при малейшей прокрутке вверх.
 *
 *  Зачем. Sticky-панель каталога — это три ряда: поиск, категории, сортировка с
 *  фильтрами. Пока человек её читает, она полезна; пока он листает товар, она
 *  занимает четверть экрана, на котором он ищет ровно не её. Прежний выбор был
 *  бинарным — либо панель всегда висит, либо её вовсе нет и до категорий надо
 *  скроллить обратно наверх. Уход по направлению прокрутки снимает выбор: вниз
 *  — экран отдан товару, вверх — панель уже на месте, потому что вверх человек
 *  листает именно за ней.
 *
 *  Почему без useState. Прокрутка — самое частое событие в приложении, а
 *  Catalog тяжёлый: ре-рендер страницы на каждое переключение направления
 *  ощущался бы как подтормаживание ровно в момент движения. Здесь двигается
 *  transform одного узла — до React дело не доходит вовсе.
 *
 *  Почему движение считается в JS, а не отдано CSS-переходу. Первая версия
 *  была на `transition: transform`, и на живом телефоне панель не уезжала, а
 *  перещёлкивалась. Причина известна и записана в lib/motion.ts: этот webview
 *  гасит декларативную анимацию целиком, свойство применяется мгновенно, и
 *  отличить «не анимировалось» от «анимировалось быстро» изнутри кода нечем.
 *  Правило проекта: движение, которое человек должен УВИДЕТЬ, считается на
 *  rAF-моторе.
 */
import { useCallback, useRef } from "react";
import { animateShiftY, TOOLBAR_HIDE_MS, transitionDuration } from "./motion";

/** Ниже этой отметки панель всегда видна: вверху экрана прятать нечего, а
 *  «дёрганье» у самой кромки — первое, что замечают как неряшливость. */
export const REVEAL_ZONE_PX = 120;
/** Меньшее движение считается дрожанием пальца, а не намерением. */
export const MOVE_EPS_PX = 6;
/** У самой кромки списка панели нечего прятать под собой: контент ещё не
 *  подъехал под неё. Там она отдаёт свой сплошной фон, и живой фон страницы
 *  идёт от верха экрана без шва. Отмеряется в пикселях от нуля, а не строгим
 *  нулём: iOS отдаёт дробные позиции. */
export const ATOP_PX = 4;
/** Отрицательный sticky-сдвиг панели (-top-3 у неё в разметке Catalog.tsx).
 *  Совпадает с padding-top скролл-контейнера; меняется вместе с ним. */
export const STICKY_OFFSET_PX = 12;

/** Всё решение целиком: prev — что сейчас, top — позиция прокрутки, delta —
 *  сдвиг с прошлого события. Отдельной функцией, потому что это единственное
 *  место с логикой, а всё остальное в модуле — подписки и DOM. */
export function nextToolbarHidden(prev: boolean, top: number, delta: number): boolean {
  if (top <= REVEAL_ZONE_PX) return false;
  if (Math.abs(delta) < MOVE_EPS_PX) return prev;
  return delta > 0;
}

/** Ближайший прокручиваемый предок. В приложении это <main> из Layout: скроллит
 *  не окно, а он, поэтому слушать window бесполезно. Ищем по вычисленному
 *  overflow, а не по имени тега: разметка Layout ещё будет меняться. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** Ref-колбэк на саму панель. Вешает подписку, когда узел появился, и снимает,
 *  когда исчез: панель живёт ровно столько же, сколько страница каталога. */
export function useHideOnScroll(enabled = true) {
  const cleanup = useRef<(() => void) | null>(null);

  // Подписку снимает сам ref-колбэк: React вызывает его с null, когда узел
  // уходит из DOM. Отдельного useEffect с cleanup здесь быть НЕ должно —
  // в StrictMode эффект размонтируется и монтируется повторно, его cleanup
  // убивал подписку, а ref-колбэк заново не вызывался (узел-то остался на
  // месте), и панель просто переставала прятаться. Поймано на живом стенде.
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el || !enabled) return;

    const scroller = scrollParentOf(el);
    if (!scroller) return;

    let hidden = false;
    let lastTop = scroller.scrollTop;
    // Текущее смещение панели: нужно как СТАРТ следующей анимации. Без него
    // разворот на полпути (человек передумал и повёл палец обратно) начинался
    // бы с нуля, то есть с прыжка в уже пройденную точку.
    let shift = 0;
    let cancelShift: (() => void) | null = null;
    // rAF-коалесценция: сколько бы событий прокрутки ни пришло за кадр, решение
    // принимаем один раз. Тот же приём, что у syncViewportVars в lib/telegram.ts.
    let raf = 0;

    // Desktop: панель статична (lg:static) и занимает место в потоке — сдвиг
    // увёл бы со страницы кусок разметки, а не освободил экран.
    const desktop = window.matchMedia("(min-width: 1024px)");

    const moveTo = (next: boolean) => {
      cancelShift?.();
      // Полная высота панели плюс её отрицательный sticky-сдвиг (-top-3):
      // без компенсации у кромки остаётся полоска нижней границы.
      const target = next ? -(el.offsetHeight + STICKY_OFFSET_PX) : 0;
      cancelShift = animateShiftY(
        el, shift, target, transitionDuration(TOOLBAR_HIDE_MS), (y) => { shift = y; },
      );
    };

    let atop = true;
    const setAtop = (next: boolean) => {
      if (next === atop) return;
      atop = next;
      el.dataset.atop = String(next);
    };
    el.dataset.atop = "true";

    const apply = () => {
      raf = 0;
      const top = scroller.scrollTop;
      // Прозрачность панели считается ОТДЕЛЬНО от её ухода: у кромки она видна
      // и прозрачна одновременно, и это не одно состояние, а два.
      setAtop(top <= ATOP_PX);
      const next = nextToolbarHidden(hidden, top, top - lastTop);
      if (Math.abs(top - lastTop) >= MOVE_EPS_PX) lastTop = top;
      if (next === hidden) return;
      hidden = next;
      el.dataset.hidden = String(next);
      if (desktop.matches) return;
      moveTo(next);
    };

    // Переход на desktop-ширину: панель обязана вернуться на место, даже если
    // её спрятали на узком экране (поворот планшета, изменение окна).
    const onBreakpoint = () => {
      cancelShift?.();
      shift = 0;
      el.style.transform = "";
    };
    desktop.addEventListener("change", onBreakpoint);
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    cleanup.current = () => {
      scroller.removeEventListener("scroll", onScroll);
      desktop.removeEventListener("change", onBreakpoint);
      cancelShift?.();
      if (raf) cancelAnimationFrame(raf);
      delete el.dataset.hidden;
      delete el.dataset.atop;
      el.style.transform = "";
    };
  }, [enabled]);
}
