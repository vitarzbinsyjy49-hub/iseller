/** «Спросить про этот товар» — вопрос к AI прямо на странице товара.
 *
 *  Раньше единственный путь был «Спросить AI» -> /ai?product=<id>: человек
 *  уходил с карточки ради одного вопроса и терял из виду цену и кнопку покупки.
 *  Теперь короткий ответ ложится рядом с товаром, а полный чат остаётся
 *  ссылкой «Продолжить в чате».
 *
 *  Запрос — тот же POST /api/ai/chat, что у чата (с product_id: backend сам
 *  достаёт товар по id и закрепляет его первым кандидатом). Отдельного
 *  endpoint'а нет и не нужно.
 *
 *  Здесь только чистая логика блока — тело запроса, переходы состояния,
 *  разбор отказа, отбор карточек, — тесты в node, как у priceOffer и cartMath.
 *  Сеть и вёрстка живут в components/ProductAskAi.tsx.
 */
import type { AiAnswer, ProductCard } from "../components/ai/types";

/** Готовые вопросы. Формулировки от лица покупателя: уходят в модель как его
 *  реплика. Товар в тексте не называем — backend знает его по id, а длинное
 *  название в вопросе только мешало бы поиску. */
export const ASK_PRESETS = [
  "Чем отличается от прошлой модели?",
  "Что есть новее или похожее?",
  "Кому подойдёт?",
] as const;

/** Потолок длины вопроса = MAX_MESSAGE_LEN на backend (schemas/ai.py). Длиннее
 *  backend отвергнет 422-й, и человек увидел бы «не получилось» вместо ответа. */
export const ASK_MAX_LEN = 1000;

/** Сколько карточек в ряду под ответом. Больше на странице товара — уже
 *  вторая витрина, а не ответ на вопрос. */
export const ASK_MAX_CARDS = 6;

export type AskKind = "preset" | "custom";
export type AskFailure = "rate_limit" | "failed";

export type AskBody = { message: string; history: []; product_id: number };

/** Тело POST /api/ai/chat. История ПУСТАЯ намеренно: вопрос из карточки —
 *  всегда первый ход. Прошлый ответ здесь же не продолжение разговора, а
 *  ответ на другой вопрос; кому нужен диалог — «Продолжить в чате».
 *  null — спрашивать нечего (пустая строка), запрос не уходит. */
export function buildAskBody(productId: number, question: string): AskBody | null {
  const message = question.trim().slice(0, ASK_MAX_LEN);
  if (!message) return null;
  return { message, history: [], product_id: productId };
}

/** Отказ запроса -> что показать. 429 — минутный лимит AI на пользователя
 *  (api/ai.py): тут честно просим подождать, а не «попробовать ещё раз»
 *  немедленно — повтор в ту же секунду снова упрётся в лимит. Всё остальное
 *  (сеть, таймаут, 5xx) — общий сбой.
 *
 *  Утиная проверка `status`, а не instanceof ApiError: модулю незачем тянуть
 *  HTTP-клиент со стором авторизации ради одного числа. */
export function askFailureOf(error: unknown): AskFailure {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 429 ? "rate_limit" : "failed";
}

export const ASK_FAILURE_TEXT: Record<AskFailure, string> = {
  rate_limit: "Слишком много вопросов подряд. Подождите минуту и спросите снова.",
  failed: "Не получилось получить ответ. Проверьте связь и попробуйте ещё раз.",
};

/** Состояние блока. `seq` — номер вопроса: ответ на прежний вопрос, пришедший
 *  после нового, отбрасывается, иначе под вторым вопросом встал бы ответ на
 *  первый. */
export type AskState =
  | { status: "idle"; seq: number }
  | { status: "loading"; seq: number; question: string; kind: AskKind; startedAt: number }
  | { status: "done"; seq: number; question: string; kind: AskKind; answer: AiAnswer; elapsedMs: number }
  | { status: "error"; seq: number; question: string; kind: AskKind; failure: AskFailure };

export type AskAction =
  | { type: "ask"; seq: number; question: string; kind: AskKind; startedAt: number }
  | { type: "answer"; seq: number; answer: AiAnswer; elapsedMs: number }
  | { type: "fail"; seq: number; failure: AskFailure };

export const ASK_INITIAL: AskState = { status: "idle", seq: 0 };

export function askReducer(state: AskState, action: AskAction): AskState {
  if (action.type === "ask") {
    // Новый вопрос вытесняет прежний, даже если тот ещё в пути: чипы на время
    // загрузки выключены, но Enter в поле ввода никто не отменял.
    return {
      status: "loading", seq: action.seq,
      question: action.question, kind: action.kind, startedAt: action.startedAt,
    };
  }
  // Ответ или отказ не на ТЕКУЩИЙ вопрос — опоздавший, его место уже занято.
  if (state.status !== "loading" || action.seq !== state.seq) return state;
  const { seq, question, kind } = state;
  if (action.type === "answer") {
    return { status: "done", seq, question, kind, answer: action.answer, elapsedMs: action.elapsedMs };
  }
  return { status: "error", seq, question, kind, failure: action.failure };
}

/** Карточки для ряда под ответом. Сам открытый товар из ряда убран: backend
 *  закрепляет его первым кандидатом, и модель охотно возвращает его же —
 *  карточка товара, на странице которого человек уже стоит, ведёт в никуда.
 *  В таблицу различий он при этом идёт: сравнение с ним и есть ответ. */
export function askCardsRow(cards: ProductCard[], productId: number): ProductCard[] {
  return cards.filter((c) => c.id !== productId).slice(0, ASK_MAX_CARDS);
}

type AiVisibility = {
  is_legendary?: boolean;
  price_note?: string;
  availability_mode?: string;
};

/** Видит ли AI этот товар. Предзаказ исключён из выдачи AI целиком
 *  (services/availability.exclude_preorder): модель не должна ни советовать то,
 *  чего нет в продаже, ни пересказывать непроверенные характеристики. Признаков
 *  два — режим и `price_note` («цену называть нельзя»): режим ровно тот, по
 *  которому режет backend, а price_note страхует от старого ответа API без
 *  availability_mode. */
export function aiSeesProduct(p: AiVisibility): boolean {
  return p.availability_mode !== "preorder" && !p.price_note;
}

/** Показывать ли блок вопроса на странице товара. У легендарной позиции свой
 *  событийный экран (LegendaryProduct) со своей кнопкой AI — блок в его
 *  раскладку не встроен и не должен. */
export function showAskInCard(p: AiVisibility): boolean {
  return !p.is_legendary && aiSeesProduct(p);
}

/** Полный чат о товаре. Один адрес на все входы — кнопку «Спросить AI»,
 *  легендарный экран и «Продолжить в чате»: AiSearch читает ровно `product`,
 *  и разъехавшийся параметр молча открыл бы чат без товара. */
export function aiChatHref(productId: number): string {
  return `/ai?product=${productId}`;
}
