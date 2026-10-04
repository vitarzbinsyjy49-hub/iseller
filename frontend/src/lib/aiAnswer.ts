/** Нормализация ответа POST /api/ai/chat.
 *
 *  Вынесено из AiSearch, когда у ответа появился второй читатель — блок
 *  «Спросить про этот товар» на странице товара. Два экрана, читающие один и
 *  тот же ответ, обязаны чинить его одинаково: иначе неполный ответ движка
 *  (нет cards/meta/actions) ронял бы один экран и проходил на другом.
 *
 *  Чистая функция, тесты в node — как answerFormat и cartMath.
 */
import type { AiAnswer } from "../components/ai/types";

/** Текст на случай, когда движок вернул ответ без текста. Карточки при этом
 *  могли прийти — и говорить «ничего не нашлось» было бы неправдой. */
export const EMPTY_ANSWER_TEXT = "Подобрал варианты — посмотрите карточки ниже или уточните запрос.";

/** Даже если backend/движок вернул неполный объект, UI не должен падать —
 *  рисуем что есть. */
export function normalizeAnswer(raw: Partial<AiAnswer> | null | undefined): AiAnswer {
  return {
    text: typeof raw?.text === "string" && raw.text ? raw.text : EMPTY_ANSWER_TEXT,
    cards: Array.isArray(raw?.cards) ? raw!.cards : [],
    actions: Array.isArray(raw?.actions) ? raw!.actions : [],
    meta: raw?.meta && typeof raw.meta === "object" ? raw.meta : {},
  };
}
