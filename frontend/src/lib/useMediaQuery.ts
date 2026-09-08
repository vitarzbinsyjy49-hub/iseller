/** Подписка на медиазапрос — чтобы ветку разметки можно было НЕ МОНТИРОВАТЬ.
 *
 *  Нужен там, где `hidden lg:block` недостаточно. Класс прячет узлы от глаз, но
 *  не от браузера: компоненты монтируются, их эффекты ходят в сеть, их хуки
 *  подписываются на сторы, а узлы участвуют в пересчёте стилей и в снимке
 *  перехода между экранами. На главной так утекали три запроса `/catalog/list`
 *  и полторы сотни карточек товара при каждом заходе с телефона.
 *
 *  Начальное значение читается синхронно, в инициализаторе useState: если
 *  начать с `false` и поправить в эффекте, desktop получит лишний кадр без
 *  сайдбара и прыжок раскладки.
 *
 *  matchMedia может отсутствовать (jsdom в тестах, старые webview) — тогда
 *  отвечаем `false`. Направление отказа выбрано намеренно: «телефон» — это
 *  меньше DOM и меньше запросов, то есть безопасная сторона.
 */
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const apply = () => setMatches(mql.matches);
    apply();
    // addEventListener — современный путь; addListener оставлен для webview,
    // где EventTarget у MediaQueryList ещё не реализован.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
    mql.addListener(apply);
    return () => mql.removeListener(apply);
  }, [query]);

  return matches;
}
