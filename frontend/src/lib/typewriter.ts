/** Бегущая подсказка в строке поиска: текст набирается и стирается сам.
 *
 *  Зачем чистая функция времени, а не таймеры с состоянием. Во-первых, весь
 *  расчёт проверяется обычными тестами без DOM и без фейковых часов — как
 *  cartMath и navTiles. Во-вторых, этим приложением движет ПОКАДРОВЫЙ мотор
 *  (lib/motion.ts), а не CSS-анимация: webview Telegram гасит декларативную
 *  анимацию целиком, и подсказка, сделанная на @keyframes, просто не поехала
 *  бы. Функции ниже — «что показать в момент t», их дёргает rAF.
 *
 *  Цепочка таймеров setTimeout здесь тоже не годится: она копит дрейф, а при
 *  возврате на вкладку после сна отдаёт очередь накопившихся срабатываний.
 *  Время как аргумент этого не умеет по построению.
 */

export type TypewriterTiming = {
  /** На один символ при наборе. */
  typeMs: number;
  /** На один символ при стирании — стираем быстрее, чем печатаем: так делает
   *  рука, и обратный ход не должен занимать столько же внимания. */
  deleteMs: number;
  /** Пауза с целой фразой: за неё её успевают прочитать. */
  holdMs: number;
  /** Пауза с пустой строкой перед следующей фразой. */
  gapMs: number;
};

export const TYPEWRITER_TIMING: TypewriterTiming = {
  typeMs: 62,
  deleteMs: 28,
  holdMs: 1500,
  gapMs: 320,
};

/** Разделитель для склейки списка фраз в одну строку.
 *
 *  Перевод строки, а НЕ пробел. Список фраз приходит литералом и на каждом
 *  рендере он новый — сравнивать его как зависимость эффекта нельзя, поэтому
 *  фразы склеиваются в строку. С пробелом в роли разделителя «мои заявки»
 *  разваливались на «мои» и «заявки»: список молча подменялся другим, а на
 *  глаз это не читалось вовсе, пока первая фраза оставалась односложной.
 *  В подсказках переводов строки не бывает — поле однострочное. */
export const PHRASE_SEPARATOR = "\n";

/** Список фраз -> одна строка (для сравнения зависимостей эффекта). */
export function packPhrases(phrases: string[]): string {
  return phrases.join(PHRASE_SEPARATOR);
}

/** Обратно в список. Пустая строка даёт пустой список, а не [""]. */
export function unpackPhrases(key: string): string[] {
  return key ? key.split(PHRASE_SEPARATOR) : [];
}

/** Сколько длится полный круг одной фразы: набор, пауза, стирание, зазор. */
export function phraseCycleMs(phrase: string, t: TypewriterTiming): number {
  return phrase.length * t.typeMs + t.holdMs + phrase.length * t.deleteMs + t.gapMs;
}

/** Длина полного круга по всем фразам. */
export function cycleMs(phrases: string[], t: TypewriterTiming): number {
  return phrases.reduce((sum, p) => sum + phraseCycleMs(p, t), 0);
}

/** Что показывать в строке через `elapsedMs` после старта.
 *
 *  Пустые фразы отбрасываются: одна такая в списке давала бы круг, в котором
 *  подсказка молча стоит пустой holdMs миллисекунд, и это читалось бы как
 *  подвисание.
 */
export function typewriterTextAt(
  phrases: string[],
  elapsedMs: number,
  timing: TypewriterTiming = TYPEWRITER_TIMING,
): string {
  const alive = phrases.filter((p) => p.length > 0);
  if (alive.length === 0) return "";

  const total = cycleMs(alive, timing);
  if (total <= 0) return "";
  // Двойной остаток — чтобы отрицательное время (вызывающий вычел старт из
  // другого источника) не давало отрицательный индекс вместо конца круга.
  let t = ((elapsedMs % total) + total) % total;

  for (const phrase of alive) {
    const span = phraseCycleMs(phrase, timing);
    if (t >= span) {
      t -= span;
      continue;
    }
    const typing = phrase.length * timing.typeMs;
    if (t < typing) {
      // +1: первый символ виден сразу. Строка, которая мгновение выглядит
      // пустой, читается как сломанная, а не как «сейчас начнёт печатать».
      return phrase.slice(0, Math.min(phrase.length, Math.floor(t / timing.typeMs) + 1));
    }
    t -= typing;
    if (t < timing.holdMs) return phrase;
    t -= timing.holdMs;
    const deleting = phrase.length * timing.deleteMs;
    if (t < deleting) {
      return phrase.slice(0, Math.max(0, phrase.length - Math.floor(t / timing.deleteMs) - 1));
    }
    return "";
  }
  return "";
}
