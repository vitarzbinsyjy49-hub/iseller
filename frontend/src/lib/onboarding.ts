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
