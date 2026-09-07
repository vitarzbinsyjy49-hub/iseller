/** Бегущая подсказка в строке поиска.
 *
 *  Что считать — в typewriter.ts (чистая функция времени, покрыта тестами).
 *  Здесь только привод: каждый кадр спрашиваем «что показать сейчас» и пишем
 *  результат в `placeholder`.
 *
 *  Почему покадрово, а не CSS-анимацией. Этот webview гасит декларативную
 *  анимацию целиком — то же правило и та же причина, что у стекла навигации
 *  (navGlass.ts) и наполнения иконок (useIconFill.ts). На @keyframes подсказка
 *  просто стояла бы неподвижно.
 *
 *  Почему пишем в DOM, а не в состояние React. Это 16 кадров в секунду смены
 *  одной строки: ре-рендер ряда навигации на каждый кадр — подтормаживание
 *  ровно в тот момент, когда человек начинает набирать. Тот же приём, что у
 *  высоты панели в BottomNav.tsx.
 *
 *  При `prefers-reduced-motion` движения нет вовсе: показываем первую фразу
 *  целиком и статично. Мигающая подсказка — ровно тот раздражитель, ради
 *  которого эту настройку включают.
 */
import { useEffect, type RefObject } from "react";

import { prefersReducedMotion } from "./motion";
import {
  TYPEWRITER_TIMING,
  packPhrases,
  typewriterTextAt,
  unpackPhrases,
  type TypewriterTiming,
} from "./typewriter";

export function useTypewriterPlaceholder(
  ref: RefObject<HTMLInputElement | null>,
  phrases: string[],
  active: boolean,
  /** Что вернуть в поле, когда подсказка останавливается. Это подпись из JSX:
   *  React не перепишет placeholder сам — мы меняли DOM-свойство в обход него,
   *  и для React значение prop'а не менялось. Без явного возврата поле осталось
   *  бы с последней фразой навсегда. */
  restoreTo: string,
  timing: TypewriterTiming = TYPEWRITER_TIMING,
) {
  // Склейка в строку — а не сам массив: литерал в JSX создаёт новый массив на
  // каждый рендер, и эффект перезапускался бы каждый раз, дёргая подсказку в
  // начало круга.
  // Разделитель и обратный разбор — в typewriter.ts, где они покрыты тестом:
  // на выборе разделителя здесь уже ошиблись однажды.
  const key = packPhrases(phrases);

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const list = unpackPhrases(key);
    if (list.length === 0) return;

    if (prefersReducedMotion()) {
      // Движения нет вовсе: мигающая подсказка — ровно тот раздражитель, ради
      // которого эту настройку включают. Поле остаётся со своей подписью.
      el.placeholder = restoreTo;
      return;
    }

    const start = performance.now();
    let raf = 0;
    let last = "";
    const frame = (now: number) => {
      const next = typewriterTextAt(list, now - start, timing);
      // Пишем только на смену символа: присваивание placeholder дёргает
      // перерисовку поля, и делать это 60 раз в секунду ради одного и того же
      // текста незачем.
      if (next !== last) {
        last = next;
        el.placeholder = next;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      // Поле, оставшееся с оборванной на середине фразой («смартфо»), выглядит
      // как сбой — возвращаем подпись.
      el.placeholder = restoreTo;
    };
  }, [ref, key, active, restoreTo, timing]);
}
