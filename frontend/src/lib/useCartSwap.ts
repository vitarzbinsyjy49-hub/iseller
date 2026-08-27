/** Превращение «Добавить» → степпер: анимация слоя, который УХОДИТ.
 *
 *  Приходящий слой играет enterRefCallback("pop") — он и так на rAF-моторе.
 *  Уходящему нужен эффект: он не появляется в DOM заново, а меняет состояние
 *  под собой, и поймать этот момент можно только сравнением с прошлым рендером.
 *
 *  useLayoutEffect, а не useEffect: React успевает применить data-hidden (в CSS
 *  это состояние покоя — прозрачность 0) до того, как эффект вернёт слою
 *  видимость. С обычным эффектом между коммитом и первым кадром анимации
 *  проскакивал бы кадр, где кнопка уже исчезла — то самое мигание, ради
 *  устранения которого всё и затевалось.
 *
 *  Первый рендер намеренно молчит: карточка товара, который УЖЕ в корзине,
 *  ничего не превращает — она просто такой открылась. Состояние покоя ей даёт
 *  CSS (.cart-morph-layer[data-hidden] в index.css).
 */
import { useLayoutEffect, useRef } from "react";
import { animateEnter, animateSwapOut } from "./motion";

export function useCartSwapOut<T extends HTMLElement>(added: boolean) {
  const ref = useRef<T>(null);
  const prevAdded = useRef(added);

  useLayoutEffect(() => {
    if (prevAdded.current === added) return;
    prevAdded.current = added;
    const el = ref.current;
    if (!el) return;
    // Стартовое значение ставим сами: слой мог остаться от прошлой анимации
    // с чужой прозрачностью, а анимация должна начинаться от видимого края.
    el.style.opacity = added ? "1" : "0";
    return added ? animateSwapOut(el) : animateEnter(el, "pop");
  }, [added]);

  return ref;
}
