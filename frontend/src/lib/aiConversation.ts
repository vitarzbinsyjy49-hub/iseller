/** Разговор с AI между экранами и сессиями — ТОЛЬКО localStorage.
 *
 *  Лента жила в useState: ушёл посмотреть карточку товара, вернулся — диалога
 *  нет. При этом история ЗАПРОСОВ сохранялась, то есть мы помнили, о чём человек
 *  спрашивал, но не помнили, что ему ответили.
 *
 *  КАРТОЧКИ ЗДЕСЬ НЕ ХРАНЯТСЯ, только их id. Карточка — снимок цены и наличия,
 *  и продержать её сутки в localStorage значит однажды показать вчерашнюю цену.
 *  При восстановлении текст встаёт мгновенно, а карточки последнего ответа
 *  догружаются свежими через `GET /catalog/by-ids`. У давних ходов карточек не
 *  будет вовсе: старый ход — это история разговора, а не витрина.
 *
 *  Чистая логика отделена от localStorage-обвязки и тестируется без DOM — как
 *  searchHistory и viewport.
 */
import type { AiAnswer, ChatItem } from "../components/ai/types";

const KEY = "aiseller_ai_conversation_v1";

/** Неделя. Роудмап обещает «продолжить подбор через неделю с того места, где
 *  остановились»; дольше это уже не продолжение разговора, а его археология. */
export const CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Сколько ходов держим. Хвост, а не начало: свежее важнее давнего. */
export const MAX_STORED_TURNS = 20;

/** Потолок на текст одного хода. Квота localStorage не бесконечна, а ответ
 *  длиннее этого читать всё равно никто не станет. */
const MAX_TEXT = 4000;

export type StoredTurn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      /** id товаров, а НЕ карточки — см. шапку модуля. */
      card_ids: number[];
      elapsed_ms: number;
      meta: AiAnswer["meta"];
    };

export type StoredConversation = {
  saved_at: number;
  focus_id: number | null;
  turns: StoredTurn[];
};

/** Лента диалога -> то, что кладём в хранилище. */
export function toStored(
  chat: ChatItem[], focusId: number | null, now: number,
): StoredConversation {
  const turns: StoredTurn[] = chat.slice(-MAX_STORED_TURNS).map((item) =>
    item.role === "user"
      ? { role: "user", text: item.text.slice(0, MAX_TEXT) }
      : {
          role: "assistant",
          text: (item.answer.text ?? "").slice(0, MAX_TEXT),
          card_ids: (item.answer.cards ?? []).map((c) => c.id),
          elapsed_ms: item.elapsed_ms,
          meta: item.answer.meta ?? {},
        });
  return { saved_at: now, focus_id: focusId, turns };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Один ход из хранилища -> проверенный ход, либо null.
 *
 *  Всё содержимое localStorage — недоверенный ввод: его мог испортить кто
 *  угодно, включая прошлую версию этого же кода. Битый ход выбрасывается
 *  поштучно, а не роняет весь разговор.
 */
function parseTurn(raw: unknown): StoredTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.text !== "string") return null;

  if (t.role === "user") return { role: "user", text: t.text };
  if (t.role !== "assistant") return null;

  const ids = Array.isArray(t.card_ids) ? t.card_ids.filter(isPositiveInt) : [];
  return {
    role: "assistant",
    text: t.text,
    card_ids: ids,
    elapsed_ms: typeof t.elapsed_ms === "number" && t.elapsed_ms >= 0 ? t.elapsed_ms : 0,
    meta: t.meta && typeof t.meta === "object" ? (t.meta as AiAnswer["meta"]) : {},
  };
}

/** Содержимое хранилища -> разговор, либо null (нет, протух, испорчен). */
export function fromStored(raw: unknown, now: number): StoredConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.saved_at !== "number" || !Number.isFinite(data.saved_at)) return null;
  if (now - data.saved_at > CONVERSATION_TTL_MS) return null;
  if (!Array.isArray(data.turns)) return null;

  const turns = data.turns.map(parseTurn).filter((t): t is StoredTurn => t !== null);
  // Ноль живых ходов — это отсутствие разговора, а не разговор из нуля ходов:
  // иначе экран показал бы кнопку «Новый разговор» над пустотой.
  if (turns.length === 0) return null;

  return {
    saved_at: data.saved_at,
    focus_id: isPositiveInt(data.focus_id) ? data.focus_id : null,
    turns: turns.slice(-MAX_STORED_TURNS),
  };
}

export function loadConversation(): StoredConversation | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? fromStored(JSON.parse(raw), Date.now()) : null;
  } catch {
    // Приватный режим, запрет на хранилище, битый JSON — разговор просто не
    // восстановится, и это не повод ломать экран.
    return null;
  }
}

export function saveConversation(chat: ChatItem[], focusId: number | null): void {
  try {
    if (chat.length === 0) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(toStored(chat, focusId, Date.now())));
  } catch {
    /* квота или приватный режим — разговор останется только в памяти */
  }
}

export function clearConversation(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
