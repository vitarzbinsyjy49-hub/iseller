/** HTTP-клиент с JWT и автоматическим обновлением access-токена. */
import { useAuthStore } from "../store/auth";

const BASE = "/api";

/** Ошибка API с реальным HTTP-статусом — чтобы вызывающий код мог отличить
 *  «не найдено» (404) от временного сбоя сети/сервера, не парся текст. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Человеческий текст ошибки из тела ответа.
 *
 *  FastAPI отдаёт `detail` строкой, но правила корзины и промокодов кладут туда
 *  ОБЪЕКТ (`{code, detail, …}`) — машинный код рядом с текстом, чтобы клиент мог
 *  различать причины, не разбирая слова. Без этой распаковки объект попадал в
 *  сообщение как есть, и человек видел «[object Object]» вместо «Вы уже
 *  применяли этот промокод». Отлавливается только глазами на живом экране:
 *  запрос при этом отработал верно, ошибка «показана», типы сошлись.
 */
export function errorText(body: unknown, status: number): string {
  const fallback = `Ошибка запроса (${status})`;
  if (!body || typeof body !== "object") return fallback;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object") {
    const inner = (detail as { detail?: unknown }).detail;
    if (typeof inner === "string" && inner.trim()) return inner;
  }
  return fallback;
}

async function rawRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const { accessToken } = useAuthStore.getState();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  return fetch(`${BASE}${path}`, { ...options, headers });
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res = await rawRequest(path, options);

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) res = await rawRequest(path, options);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(errorText(body, res.status), res.status);
  }
  return res.json();
}

/** Идущий сейчас обмен токена. Refresh одноразовый (backend отзывает его jti),
 *  поэтому параллельные 401 обязаны ждать ОДИН общий запрос: иначе второй
 *  предъявит уже отозванный токен, получит 401 и разлогинит пользователя. */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  const { refreshToken, setTokens, clear } = useAuthStore.getState();
  if (!refreshToken) return false;
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    clear();
    return false;
  }
  const data = await res.json();
  setTokens(data.access_token, data.refresh_token);
  return true;
}
