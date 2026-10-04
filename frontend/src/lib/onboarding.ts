/** Чистая логика сторис-онбординга — вынесена из компонента, чтобы граничные
 *  случаи (последний слайд, тап у самого края) проверялись тестом, а не
 *  только глазами в браузере. */

/** Показывать ли онбординг: только у авторизованного пользователя, который
 *  ещё ни разу его не видел. null означает «ещё не видел» — одинаково и для
 *  только что созданного, и для давно существующего пользователя. */
export function shouldShowOnboarding(user: { onboarding_seen_at: string | null } | null): boolean {
  return !!user && user.onboarding_seen_at === null;
}

/** Следующий индекс слайда, либо "complete" при уходе за последний — так
 *  вызывающий код не может случайно отрисовать несуществующий слайд.
 *  "prev" на первом слайде — не-оп (остаёмся на месте). */
export function advanceSlide(
  index: number,
  count: number,
  direction: "next" | "prev",
): number | "complete" {
  if (direction === "prev") return Math.max(0, index - 1);
  const next = index + 1;
  return next >= count ? "complete" : next;
}

/** Тап-зона по горизонтальной доле экрана (0..1): левая треть — назад,
 *  остальное — вперёд. Тот же порог, что у Instagram/Telegram-сторис. */
export function tapZoneFor(xRatio: number): "prev" | "next" {
  return xRatio < 1 / 3 ? "prev" : "next";
}

/** Доля ширины экрана, после которой отпущенный свайп листает. */
const SWIPE_DISTANCE_RATIO = 0.25;
/** Скорость смахивания (px/мс), при которой листает и короткий жест. */
const SWIPE_FLICK_SPEED = 0.5;

/** Куда докатить экран, когда палец отпущен. dx < 0 — палец ушёл влево
 *  (к следующему экрану), velocity — px/мс со знаком, как у dx.
 *
 *  Быстрый рывок учитывается, только если он в ту же сторону, что и сдвиг:
 *  потянул влево и дёрнул обратно — это отмена, а не «назад через ноль». */
export function releaseDirection(dx: number, width: number, velocity: number): "next" | "prev" | "stay" {
  if (dx === 0) return "stay";
  const sameWay = Math.sign(velocity) === Math.sign(dx);
  const far = Math.abs(dx) > width * SWIPE_DISTANCE_RATIO;
  const flick = sameWay && Math.abs(velocity) > SWIPE_FLICK_SPEED;
  if (!far && !flick) return "stay";
  if (far && !sameWay && Math.abs(velocity) > SWIPE_FLICK_SPEED) return "stay";
  return dx < 0 ? "next" : "prev";
}

/** Сдвиг экрана за пальцем. Назад с первого экрана тянется туго (в треть
 *  хода пальца) — там ничего нет, но жест должен ощущаться живым, а не
 *  упираться в стену. Вперёд с последнего — свободно: это закрытие. */
export function dragOffset(dx: number, index: number, _count: number): number {
  if (index === 0 && dx > 0) return dx / 3;
  return dx;
}

/** Тап — короткое касание почти без движения. Долгое удержание — пауза
 *  автопролистывания, как в сторис Telegram, и экран не листает. */
export function isTap(distancePx: number, durationMs: number): boolean {
  return distancePx < 10 && durationMs < 350;
}
