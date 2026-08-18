/** Галочка «Заявка отправлена/принята» — общий финальный экран визарда
 *  «Продать товар», корзины, формы заявки и ИИ-сценария. Появление — своим
 *  мотором (rAF + easeOutQuint из lib/motion), а не CSS-анимацией — тот же
 *  урок, что уже разобран в motion.ts, только острее: у контейнера раньше
 *  стоял класс `pop-in` (CSS @keyframes popIn), и на живом iOS в Telegram (с
 *  системным «уменьшить движение») кружок замирал на СТАРТОВОМ кадре —
 *  opacity:0 — то есть не появлялся вообще, хотя в тестовом Chromium-браузере
 *  отрисовывался нормально.
 *
 *  Два движения разом: сам круг (64px) увеличивается с 0.6 до 1 — это крупное,
 *  заметное движение, — и одновременно дорисовывается штрих галочки. Раньше
 *  здесь была ТОЛЬКО дорисовка маленькой (24px) иконки — на глаз, особенно при
 *  «уменьшить движение» (короче в 2.5 раза, см. FADE_MS), это читалось как
 *  «анимации нет», хотя технически она отрабатывала. */
import { useEffect, useRef } from "react";
import { animateNumber, transitionDuration } from "../lib/motion";

// Длина контура галочки (path "m5 12.5 4.5 4.5L19 7.5") — 19.8, берём с запасом:
// у stroke-linecap="round" остаток короче реальной длины виден как точка, а не штрих.
const CHECK_PATH_LENGTH = 21;

export function AnimatedCheck() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const path = pathRef.current;
    if (!container || !path) return;
    const duration = transitionDuration(420);
    const cancelScale = animateNumber(0.6, 1, duration,
      (v) => { container.style.transform = `scale(${v})`; });
    const cancelStroke = animateNumber(CHECK_PATH_LENGTH, 0, duration,
      (v) => { path.style.strokeDashoffset = String(v); });
    return () => { cancelScale(); cancelStroke(); };
  }, []);

  return (
    <div ref={containerRef}
      className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green/15 text-green">
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor"
        strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <path
          ref={pathRef}
          d="m5 12.5 4.5 4.5L19 7.5"
          strokeDasharray={CHECK_PATH_LENGTH}
          strokeDashoffset={CHECK_PATH_LENGTH}
        />
      </svg>
    </div>
  );
}
