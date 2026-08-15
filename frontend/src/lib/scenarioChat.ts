/** Клиентский стейт-машин AI-чата сценарных заявок (Trade-In/бизнес/опт).
 *
 *  Чистые функции без DOM (vitest, node-окружение) — тот же приём, что у
 *  scenario.ts. Скрипт (не модель) решает, что показать следующим: тап по
 *  чипу или совпавший по синонимам свободный текст двигают диалог без сети.
 *  Эскалация к AI (POST /api/scenario-chat/turn) нужна только когда
 *  needsEscalation() вернула true — см. ScenarioChat.tsx.
 */
import type { Field, ScenarioConfig } from "./scenario";

export type ChatStep =
  | { kind: "field"; field: Field }
  | { kind: "phone" }
  | { kind: "summary" };

/** Шаги диалога: все поля сценария по порядку, затем телефон, затем сводка. */
export function stepsFor(cfg: ScenarioConfig): ChatStep[] {
  return [
    ...cfg.fields.map((field): ChatStep => ({ kind: "field", field })),
    { kind: "phone" },
    { kind: "summary" },
  ];
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** needle встречается в haystack как отдельное слово/фраза, не как часть
 *  другого слова. JS `\b` не годится: он основан на ASCII `\w` и не видит
 *  границ кириллицы (переход кириллица-кириллица не считается границей) —
 *  поэтому границы проверяются вручную через lookaround по «не буква/не
 *  цифра» (`\p{L}`/`\p{N}`, флаг `u`). Без этого короткий синоним «бу»
 *  случайно матчился бы на «будет»: подстрока есть, слово — другое. */
function containsAsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "u");
  return re.test(haystack);
}

/** Локальный матчинг свободного текста на chips-вариант: label или синоним,
 *  найденный как отдельное слово/фраза (не подстрока внутри другого слова).
 *  null для не-chips полей и при отсутствии совпадения — тогда решает
 *  needsEscalation, эскалировать ли к AI. */
export function matchChip(field: Field, text: string): string | null {
  if (field.kind !== "chips") return null;
  const norm = normalize(text);
  if (!norm) return null;
  for (const opt of field.options) {
    const candidates = [opt.label, ...(opt.synonyms ?? [])].map(normalize);
    if (candidates.some((c) => containsAsWord(norm, c))) return opt.value;
  }
  return null;
}

// Вопросительный знак ИЛИ типичные вопросительные слова/обороты — намеренно
// широко: ошибка в эту сторону стоит один лишний вызов AI-эскалации, ошибка
// в другую — заявка молча уезжает с бессмысленным значением поля.
const QUESTION_RE = /\?|сколько|почему|зачем|а если|что если|можно ли|как долго|когда/iu;

export function looksLikeQuestion(text: string): boolean {
  return QUESTION_RE.test(text);
}

/** Нужна ли AI-эскалация: ТОЛЬКО для chips-полей — вопрос или отсутствие
 *  локального совпадения. Свободный текст (text/textarea) принимается как
 *  есть всегда, даже если похож на вопрос: там не было и не должно быть
 *  валидации, кроме «не пусто» (ScenarioSheet). Раньше вопрос эскалировался
 *  в любом поле — из-за этого текст, напечатанный в "Комментарий", мог уйти
 *  на AI-ответ по FAQ, а сам текст покупателя терялся: он никуда не
 *  сохранялся. */
export function needsEscalation(field: Field, text: string): boolean {
  if (field.kind !== "chips") return false;
  if (looksLikeQuestion(text)) return true;
  return matchChip(field, text) === null;
}

export function isRequired(field: Field): boolean {
  return "required" in field && field.required === true;
}
