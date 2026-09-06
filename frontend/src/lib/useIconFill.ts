/** Наполнение иконки при переходе в активное состояние.
 *
 *  Две версии одного рисунка лежат друг на друге: контур и силуэт. Активной
 *  вкладке силуэт проступает, неактивной — гаснет. Это второй признак состояния
 *  помимо цвета, и он не декоративный: активную вкладку, отличающуюся ТОЛЬКО
 *  цветом, не найдёт человек с нарушением цветовосприятия.
 *
 *  Почему покадрово, а не CSS-переходом. Этот webview гасит декларативную
 *  анимацию целиком — `transition: opacity` здесь не «быстрый», а мгновенный,
 *  и наполнение превращалось бы в подмену картинки. То же правило и та же
 *  причина, что у стекла навигации и у обмена кнопки корзины на степпер.
 *
 *  Первый рендер намеренно молчит: вкладка, открытая активной, ничего не
 *  наполняет — она просто такой отрисовалась. Состояние покоя ей даёт CSS.
 */
import { useLayoutEffect, useRef } from "react";

import { animateOpacity, prefersReducedMotion, FADE_MS } from "./motion";

/** Длительность наполнения. Короче обмена целого ряда (300мс) и длиннее
 *  мгновенного щелчка: иконка меняет материал, а не уезжает, и растягивать
 *  это движение не на чем. */
export const ICON_FILL_MS = 200;

/** Ставит рефы на слой контура и слой заливки. Возвращает оба — вешать на
 *  соседние узлы внутри одной иконки. */
export function useIconFill<T extends HTMLElement>(active: boolean) {
  const outlineRef = useRef<T | null>(null);
  const fillRef = useRef<T | null>(null);
  const prev = useRef(active);

  useLayoutEffect(() => {
    if (prev.current === active) return;
    prev.current = active;
    const out = outlineRef.current;
    const fil = fillRef.current;
    if (!out || !fil) return;

    const ms = prefersReducedMotion() ? FADE_MS : ICON_FILL_MS;
    // Слои идут навстречу, а не по очереди: последовательная смена читается
    // как «пропало, потом появилось», одновременная — как наполнение.
    const cancelOut = animateOpacity(out, active ? 1 : 0, active ? 0 : 1, ms);
    const cancelFil = animateOpacity(fil, active ? 0 : 1, active ? 1 : 0, ms);
    return () => {
      cancelOut();
      cancelFil();
      // Отмена в моторе намеренно не доводит значение до конца — это верно для
      // прерванного жеста, но здесь обрыв непреднамеренный (быстрое
      // переключение вкладок, размонтирование). Без доводки слои остались бы
      // полупрозрачными оба сразу, и иконка выглядела бы грязной.
      out.style.opacity = active ? "0" : "1";
      fil.style.opacity = active ? "1" : "0";
    };
  }, [active]);

  return { outlineRef, fillRef };
}
