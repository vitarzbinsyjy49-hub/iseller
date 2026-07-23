/** История поисковых запросов пользователя — ТОЛЬКО localStorage.
 *
 *  Никакой отдельной БД/сервера: история нужна для «полезного пустого
 *  состояния» поиска и живёт на устройстве. Пользователь может очистить её
 *  одной кнопкой. Пустые/слишком длинные запросы не сохраняются.
 *
 *  Чистая логика (addToHistory) отделена от localStorage-обвязки — тестируется
 *  в node без DOM (как viewport.ts).
 */

const KEY = "aiseller_search_history_v1";
const AI_KEY = "aiseller_ai_history_v1";
export const HISTORY_LIMIT = 8;
const MAX_QUERY_LEN = 80;

/** Чистая функция: добавить запрос в список истории.
 *  - trim, пустое/односимвольное не сохраняем;
 *  - дедуп без учёта регистра (свежий вариант поднимается наверх);
 *  - максимум HISTORY_LIMIT записей, свежие первыми. */
export function addToHistory(list: string[], raw: string): string[] {
  const q = raw.trim().slice(0, MAX_QUERY_LEN);
  if (q.length < 2) return list;
  const lower = q.toLowerCase();
  const rest = list.filter((item) => item.toLowerCase() !== lower);
  return [q, ...rest].slice(0, HISTORY_LIMIT);
}

function read(key: string = KEY): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function push(key: string, raw: string): string[] {
  const next = addToHistory(read(key), raw);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* private mode / quota — история просто не сохранится */
  }
  return next;
}

function clear(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function loadSearchHistory(): string[] {
  return read(KEY);
}
export function pushSearchQuery(raw: string): string[] {
  return push(KEY, raw);
}
export function clearSearchHistory(): void {
  clear(KEY);
}

/** История запросов к AI-подбору — тот же локальный механизм, отдельный ключ.
 *  На сервер ничего не отправляется; пользователь может очистить одной кнопкой. */
/** Что делать при входе на /ai с query-параметрами. Чистая функция —
 *  тестируется без DOM; guard от двойной отправки (StrictMode/remount)
 *  выражен параметром consumed. */
export function aiEntryAction(
  q: string | null,
  auto: boolean,
  consumed: boolean,
): "none" | "prefill" | "submit" {
  if (!q || !q.trim() || consumed) return "none";
  return auto ? "submit" : "prefill";
}

export function loadAiHistory(): string[] {
  return read(AI_KEY);
}
export function pushAiQuery(raw: string): string[] {
  return push(AI_KEY, raw);
}
export function clearAiHistory(): void {
  clear(AI_KEY);
}
