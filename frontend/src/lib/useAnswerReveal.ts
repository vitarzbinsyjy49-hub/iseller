/** Посимвольный набор только что полученного ответа AI.
 *
 *  Вынесено из AiSearch, когда ответ стал появляться и на странице товара
 *  (components/ProductAskAi): у набора тонкая механика — кадры rAF плюс
 *  страховочный таймер, — и две её копии разошлись бы на первой же правке.
 *  Сам расчёт (сколько символов показать к моменту t) — чистые функции в
 *  lib/answerReveal; здесь только их привязка к кадрам.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseAnswer, plainText } from "./answerFormat";
import { prefersReducedMotion, revealDurationMs, revealedChars } from "./answerReveal";

export function useAnswerReveal() {
  // null — «набирать нечего»: либо ответ уже показан целиком, либо это старое
  // сообщение в истории диалога. Число — сколько символов показано прямо
  // сейчас; по нему же решается, пора ли прикладывать карточки (они ждут конца
  // набора).
  const [revealChars, setRevealChars] = useState<number | null>(null);
  const revealRaf = useRef<number | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Снять набор: показать ответ целиком. Одна точка выхода для обеих ветвей —
   *  и для кадров rAF, и для страховочного таймера. */
  const finishReveal = useCallback(() => {
    if (revealRaf.current !== null) { cancelAnimationFrame(revealRaf.current); revealRaf.current = null; }
    if (revealTimer.current !== null) { clearTimeout(revealTimer.current); revealTimer.current = null; }
    // null вместо length: «набор закончен» и «набирать нечего» — одно состояние
    // для рендера, поэтому не держим два разных признака.
    setRevealChars(null);
  }, []);

  /** Запустить набор текста только что полученного ответа.
   *
   *  rAF, а не setInterval: интервал не синхронизирован с кадрами и на слабом
   *  устройстве даёт рваный набор. Кадр пропущен — ничего не сломается, число
   *  символов считается от реального времени, а не накоплением шагов.
   *
   *  Плюс страховочный таймер: rAF в скрытой вкладке НЕ вызывается. Свернул
   *  Mini App посреди набора — без таймера текст остался бы недописанным, а
   *  карточки не появились бы вовсе. Таймеры в фоне работают (пусть и
   *  притормаживают), поэтому набор всегда доводится до конца. Проверено живьём:
   *  в скрытой панели браузера кадры не шли, и набор висел неоконченным. */
  const startReveal = useCallback((text: string) => {
    finishReveal();
    // Считаем по тексту БЕЗ разметки: символы `**` и `- ` на экран не попадают,
    // и если мерить по сырому ответу, набор «залипал» бы на невидимом.
    const length = plainText(parseAnswer(text)).length;
    // Пустой текст показываем сразу. При «уменьшить движение» набор НЕ
    // выключается — он короче: текст не движется, а проявляется, и без него
    // ответ возникал стеной (жалоба с телефона в Telegram).
    if (!length) return;
    const reduced = prefersReducedMotion();
    const startedAt = performance.now();
    const total = revealDurationMs(length, reduced);
    setRevealChars(0);
    const step = () => {
      const elapsed = performance.now() - startedAt;
      if (elapsed >= total) { finishReveal(); return; }
      setRevealChars(revealedChars(length, elapsed, reduced));
      revealRaf.current = requestAnimationFrame(step);
    };
    revealRaf.current = requestAnimationFrame(step);
    // Запас 400мс: если кадры идут нормально, таймер не успевает сработать.
    revealTimer.current = setTimeout(finishReveal, total + 400);
  }, [finishReveal]);

  // Уход с экрана посреди набора не должен оставлять висящий кадр или таймер.
  useEffect(() => () => {
    if (revealRaf.current !== null) cancelAnimationFrame(revealRaf.current);
    if (revealTimer.current !== null) clearTimeout(revealTimer.current);
  }, []);

  return { revealChars, startReveal, finishReveal };
}
