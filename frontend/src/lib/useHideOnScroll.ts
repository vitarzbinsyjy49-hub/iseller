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
 *  ощущался бы как подтормаживание ровно в момент движения. Здесь меняется
 *  один атрибут на одном узле, а анимацию (transform) делает CSS — до React
 *  дело не доходит вовсе.
 */
import { useCallback, useRef } from "react";

/** Ниже этой отметки панель всегда видна: вверху экрана прятать нечего, а
 *  «дёрганье» у самой кромки — первое, что замечают как неряшливость. */
export const REVEAL_ZONE_PX = 120;
/** Меньшее движение считается дрожанием пальца, а не намерением. */
export const MOVE_EPS_PX = 6;

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
    // rAF-коалесценция: сколько бы событий прокрутки ни пришло за кадр, атрибут
    // трогаем один раз. Тот же приём, что у syncViewportVars в lib/telegram.ts.
    let raf = 0;

    const apply = () => {
      raf = 0;
      const top = scroller.scrollTop;
      const next = nextToolbarHidden(hidden, top, top - lastTop);
      if (Math.abs(top - lastTop) >= MOVE_EPS_PX) lastTop = top;
      if (next === hidden) return;
      hidden = next;
      el.dataset.hidden = String(next);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    cleanup.current = () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      delete el.dataset.hidden;
    };
  }, [enabled]);
}
