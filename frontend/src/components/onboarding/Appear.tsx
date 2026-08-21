/** Проявление элемента слайда онбординга — замена CSS-классов
 *  `.onboarding-appear`/`.stagger` (index.css): системное «убрать анимации»
 *  гасит декларативную CSS-анимацию целиком, что бы ни было в
 *  `@media (prefers-reduced-motion)`. Тот же баг уже чинили для баннера
 *  витрины (fix(анимации) 95fa083) переводом на requestAnimationFrame —
 *  онбординг тогда не тронули. См. lib/motion.ts::animateAppear.
 *
 *  Всегда рендерит div — если нужен семантический тег (h1, p), кладите его
 *  внутрь без классов: типографика (размер, вес, интерлиньяж, цвет)
 *  наследуется от обёртки, отступы/ширина на самой обёртке дают тот же бокс,
 *  что раньше давал класс на самом теге. */
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { animateAppear, staggerDelayMs } from "../../lib/motion";

// Реэкспорт: staggerDelayMs переехал в lib/motion.ts (им пользуются и обычные
// карточки списков через lib/useEnter, не только онбординг), но три сцены
// онбординга уже импортируют его отсюда — незачем их трогать ради переезда.
export { staggerDelayMs };

export function Appear({
  delayMs = 0,
  className,
  style,
  children,
}: {
  delayMs?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancel = () => {};
    const timer = window.setTimeout(() => { cancel = animateAppear(el); }, delayMs);
    return () => { window.clearTimeout(timer); cancel(); };
  }, [delayMs]);

  return (
    <div ref={ref} className={className} style={{ opacity: 0, ...style }}>
      {children}
    </div>
  );
}
