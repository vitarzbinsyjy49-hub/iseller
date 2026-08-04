import { useEffect, useRef } from "react";
import { animateNumber, prefersReducedMotion } from "../lib/motion";

/** Блик по легендарной карточке — единственная «редкая» вещь в каталоге, и
 *  единственное место, где интерфейс позволяет себе украшение.
 *
 *  Почему кадрами из JS, а не CSS-анимацией. На части устройств система гасит
 *  ВСЮ декларативную анимацию разом (см. шапку lib/motion.ts): `@keyframes`
 *  применяется мгновенно, и блик либо не виден вовсе, либо мигает одним кадром.
 *  У владельца проекта «уменьшить движение» включено постоянно — то есть
 *  CSS-вариант не работал бы ровно у того, для кого он делается.
 *
 *  Свечения ЗА пределами карточки здесь нет намеренно: сверху карточку
 *  перекрывают заголовок секции и шапка, снизу — плавающая панель корзины, и
 *  внешний ореол обрезался бы ими вкривь. Блик живёт внутри, под `overflow:
 *  hidden` карточки, поэтому обрезаться ему нечем.
 */

/** Сколько едет блик через карточку. Медленнее продуктовых переходов: он не
 *  отвечает на действие, а привлекает внимание. */
const SWEEP_MS = 900;
/** Ответ на палец — заметно быстрее и ярче: это уже обратная связь. */
const PRESS_SWEEP_MS = 620;
/** Пауза между фоновыми проходами. Редко намеренно: блик раз в несколько
 *  секунд читается как свойство вещи, блик раз в секунду — как поломка. */
const IDLE_GAP_MS = 5_200;

const IDLE_ALPHA = 0.32;
const PRESS_ALPHA = 0.8;

export function LegendaryGloss() {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    const card = el?.parentElement;
    if (!el || !card) return;

    let cancel = () => {};
    let timer = 0;
    let visible = false;

    // «Убрать движение» — не «убрать событие»: вместо проезда блик
    // проявляется и гаснет на месте. Та же линия, что у ленты баннеров.
    const sweep = (alpha: number, durationMs: number) => {
      cancel();
      if (prefersReducedMotion()) {
        el.style.transform = "translateX(0) skewX(-18deg)";
        cancel = animateNumber(0, 1, durationMs, (t) => {
          // Треугольник: разгорается к середине, гаснет к концу.
          el.style.opacity = String(alpha * (1 - Math.abs(t * 2 - 1)));
        });
        return;
      }
      el.style.opacity = String(alpha);
      cancel = animateNumber(-140, 240, durationMs, (v) => {
        el.style.transform = `translateX(${v}%) skewX(-18deg)`;
      }, () => { el.style.opacity = "0"; });
    };

    const loop = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (visible) sweep(IDLE_ALPHA, SWEEP_MS);
        loop();
      }, IDLE_GAP_MS);
    };

    // Кадры не считаем, пока карточки нет на экране: лента «недавно смотрели»
    // уезжает за край, и фоновый rAF там был бы работой в стол.
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.4 });
    io.observe(card);

    // Отсчёт до фонового прохода начинается заново: иначе таймер, заведённый
    // до нажатия, срывал ответ на палец на середине и подменял яркий блик
    // тусклым — выглядело как сбой ровно в момент, когда человек тронул вещь.
    const onPress = () => { sweep(PRESS_ALPHA, PRESS_SWEEP_MS); loop(); };
    card.addEventListener("pointerdown", onPress);
    loop();

    return () => {
      io.disconnect();
      card.removeEventListener("pointerdown", onPress);
      window.clearTimeout(timer);
      cancel();
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 z-20 w-2/5"
      style={{
        opacity: 0,
        transform: "translateX(-140%) skewX(-18deg)",
        background:
          "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,240,205,.75) 45%, rgba(255,255,255,.95) 55%, rgba(255,240,205,.0) 100%)",
      }}
    />
  );
}
