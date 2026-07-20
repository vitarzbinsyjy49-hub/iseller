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
    throw new ApiError(body.detail || `Ошибка запроса (${res.status})`, res.status);
  }
  return res.json();
}

async function tryRefresh(): Promise<boolean> {
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
