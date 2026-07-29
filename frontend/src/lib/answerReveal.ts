/** Плавный показ ответа AI: сначала «набирается» текст, потом прикладываются
 *  карточки.
 *
 *  Зачем вынесено из компонента: тайминги — единственное, что здесь можно
 *  сломать незаметно, а vitest в проекте работает без DOM (только чистые
 *  функции). Компонент остаётся тонким: считает время, спрашивает у этих
 *  функций сколько символов показать, и всё.
 *
 *  Почему не посимвольная скорость («N знаков в секунду»): ответы AI бывают и
 *  200, и 900 символов. При фиксированной скорости короткий ответ мелькнёт, а
 *  длинный заставит ждать несколько секунд после того, как данные УЖЕ пришли —
 *  ожидание на пустом месте. Поэтому длительность зажата между полом и потолком.
 *
 *  Важно понимать масштаб: окно масштабирования — примерно 50-214 символов
 *  (пол/MS_PER_CHAR и потолок/MS_PER_CHAR). Типичный ответ консультанта длиннее,
 *  поэтому на практике почти каждый набирается за постоянные REVEAL_MAX_MS. Так
 *  и задумано: скорость набора — вопрос читаемости, а не длины текста.
 */

/** Пол и потолок длительности набора. 350мс — ниже этого текст не «набирается»,
 *  а мигает; 1500мс — выше этого пользователь ждёт зря, данные уже в браузере. */
export const REVEAL_MIN_MS = 350;
export const REVEAL_MAX_MS = 1500;
/** Ориентир для средней длины ответа (~250-600 символов). */
export const REVEAL_MS_PER_CHAR = 7;

/** Сколько всего длится набор текста такой длины. */
export function revealDurationMs(length: number): number {
  if (length <= 0) return 0;
  return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, length * REVEAL_MS_PER_CHAR));
}

/** Сколько символов показано к моменту elapsedMs. Линейно: набор текста должен
 *  идти ровно, ускорение к концу читается как рывок. */
export function revealedChars(length: number, elapsedMs: number): number {
  if (length <= 0) return 0;
  if (elapsedMs <= 0) return 0;
  const total = revealDurationMs(length);
  if (elapsedMs >= total) return length;
  return Math.round((elapsedMs / total) * length);
}

/** Пользователь просил не анимировать — показываем ответ целиком сразу.
 *  Не в общем CSS-блоке `prefers-reduced-motion`, потому что здесь дело не в
 *  длительности анимации: посимвольный показ нужно не ускорить, а выключить. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
