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

/** Локальный матчинг свободного текста на chips-вариант: точный label или
 *  вхождение синонима. null для не-chips полей и при отсутствии совпадения —
 *  тогда решает needsEscalation, эскалировать ли к AI. */
export function matchChip(field: Field, text: string): string | null {
  if (field.kind !== "chips") return null;
  const norm = normalize(text);
  if (!norm) return null;
  for (const opt of field.options) {
    const candidates = [opt.label, ...(opt.synonyms ?? [])].map(normalize);
    if (candidates.some((c) => norm === c || norm.includes(c))) return opt.value;
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

/** Нужна ли AI-эскалация: вопрос в любом поле, ИЛИ chips-поле без локального
 *  совпадения. Свободный текст без признаков вопроса принимается как есть —
 *  там и раньше не было валидации, кроме «не пусто» (ScenarioSheet). */
export function needsEscalation(field: Field, text: string): boolean {
  if (looksLikeQuestion(text)) return true;
  if (field.kind === "chips") return matchChip(field, text) === null;
  return false;
}

export function isRequired(field: Field): boolean {
  return "required" in field && field.required === true;
}
