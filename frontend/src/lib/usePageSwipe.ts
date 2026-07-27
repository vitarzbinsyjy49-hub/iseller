/** Хук свайп-навигации: жест на <main> -> переход между страницами.
 *
 *  Вся логика «куда ведёт жест» — в lib/pageSwipe (без DOM, под тестами); здесь
 *  только слушатели указателя и вызов навигации.
 *
 *  Сознательно НЕ тянем страницу за пальцем: живое перетаскивание требует
 *  держать в DOM обе страницы разом (со всеми их запросами и скролл-позициями),
 *  а сейчас на экране всегда ровно один <Outlet />. Вместо этого жест
 *  распознаётся на отпускании, а направленность возвращает анимация въезда —
 *  ощущение направления сохраняется, устройство карты роутов не меняется.
 *
 *  Мышь игнорируем: на desktop горизонтальное перетаскивание — это выделение
 *  текста, и там навигация и так есть в шапке.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { track } from "./analytics";
import { haptic } from "./telegram";
import {
  EDGE_ZONE,
  SWIPE_TABS,
  classifyPageSwipe,
  enterAnimationFor,
  resolveSwipeNav,
  tabIndexOf,
} from "./pageSwipe";

/** Поля ввода и явные отказы: там горизонтальный жест принадлежит контенту. */
const OPT_OUT = "[data-noswipe],input,textarea,select";

/** Начался ли жест внутри горизонтального скроллера (карусель фото, лента
 *  категорий, ряд «похожих товаров»).
 *
 *  Определяем по факту — вычисленный overflow-x и наличие реального запаса
 *  прокрутки, — а не по маркерам в разметке. Таких лент в приложении около
 *  десятка, и любая новая, добавленная позже, автоматически перехватила бы
 *  жест у навигации, если бы кто-то забыл проставить атрибут.
 *
 *  Идём вверх ДО <main>, не включая его: у main задан overflow-y:auto, а по
 *  спецификации это делает вычисленный overflow-x тоже auto — main опознался бы
 *  как горизонтальный скроллер и глушил бы навигацию на любой странице, которая
 *  вылезла по ширине хоть на пиксель. */
function startedInsideHorizontalScroller(target: Element | null, root: Element): boolean {
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth - el.clientWidth <= 1) continue;
    const overflowX = getComputedStyle(el).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") return true;
  }
  return false;
}

export type EnterAnimation = "from-left" | "from-right" | null;

/** Есть ли куда возвращаться внутри приложения. react-router держит порядковый
 *  номер записи в history.state.idx; 0 означает, что мы вошли сразу на этот
 *  экран (диплинк из чата) — уходить «назад» из мини-аппа нельзя, поэтому
 *  подставляем корневую вкладку. */
function hasAppHistory(): boolean {
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  return typeof idx === "number" ? idx > 0 : false;
}

export function usePageSwipe() {
  const navigate = useNavigate();
  const location = useLocation();
  // Направление жеста копится до перехода и забирается первым же рендером новой
  // страницы. Именно рендером, а не эффектом: <main> монтируется заново вместе
  // с маршрутом, CSS-анимация стартует сразу при монтировании, и класс, который
  // приехал бы позже (из эффекта), перезапустил бы уже проигрывающуюся
  // анимацию — переход дёргался бы дважды.
  const pendingAnimation = useRef<EnterAnimation>(null);
  const shownAnimation = useRef<{ key: string; animation: EnterAnimation }>({
    key: "", animation: null,
  });
  const gesture = useRef<
    { x: number; y: number; startedAt: number; fromEdge: boolean; width: number } | null
  >(null);

  if (shownAnimation.current.key !== location.key) {
    // Идемпотентно для одного и того же location.key, поэтому безопасно и при
    // повторном рендере (StrictMode).
    shownAnimation.current = { key: location.key, animation: pendingAnimation.current };
    pendingAnimation.current = null;
  }
  const enterAnimation = shownAnimation.current.animation;

  function onPointerDown(e: ReactPointerEvent<HTMLElement>) {
    gesture.current = null;
    if (e.pointerType === "mouse") return;
    const target = e.target as Element | null;
    if (target?.closest?.(OPT_OUT)) return;
    if (startedInsideHorizontalScroller(target, e.currentTarget)) return;
    gesture.current = {
      x: e.clientX,
      y: e.clientY,
      startedAt: performance.now(),
      fromEdge: e.clientX <= EDGE_ZONE,
      width: e.currentTarget.clientWidth || window.innerWidth,
    };
  }

  function onPointerUp(e: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;

    const dir = classifyPageSwipe(
      e.clientX - g.x, e.clientY - g.y, g.width, performance.now() - g.startedAt,
    );
    if (!dir) return;
    const target = resolveSwipeNav(location.pathname, dir, g.fromEdge);
    if (!target) return;

    track("page_swiped", {
      from: location.pathname,
      direction: dir,
      target: target.kind === "tab" ? target.to : "back",
    });
    pendingAnimation.current = enterAnimationFor(dir);
    haptic("light");
    if (target.kind === "tab") navigate(target.to);
    else if (hasAppHistory()) navigate(-1);
    else navigate(SWIPE_TABS[0]);   // вошли по диплинку — некуда возвращаться
  }

  function onPointerCancel() {
    gesture.current = null;
  }

  return {
    enterAnimation,
    /** true, если текущий путь — корневая вкладка (нет экрана «выше»). */
    isTabRoute: tabIndexOf(location.pathname) >= 0,
    /** Уйти на экран выше тем же путём, что и свайп «назад». */
    goBack: () => {
      pendingAnimation.current = enterAnimationFor("right");
      if (hasAppHistory()) navigate(-1);
      else navigate(SWIPE_TABS[0]);
    },
    swipeHandlers: {
      onPointerDown,
      onPointerUp,
      onPointerCancel,
    },
  };
}
