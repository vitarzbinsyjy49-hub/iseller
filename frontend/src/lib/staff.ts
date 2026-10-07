/** Режим администратора Mini App: вход с подтверждением в боте и правка цен.
 *
 *  Staff-токен — отдельный от покупательского и живёт 2 часа. Храним его в
 *  sessionStorage: переживает перезагрузку вкладки, но не закрытие Mini App, и
 *  никогда не попадает в localStorage рядом с покупательскими данными.
 *  Защищает не этот файл, а сервер (api/staff.py): здесь только удобство.
 */
import { api, ApiError, errorText } from "./api";

const KEY = "staff_session";

type Session = { token: string; exp: number };

function read(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s.token && s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function staffToken(): string | null {
  return read()?.token ?? null;
}

export function hasStaffSession(): boolean {
  return read() !== null;
}

export function saveStaffSession(token: string, expiresInSec: number): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ token, exp: Date.now() + expiresInSec * 1000 - 30_000 }));
  } catch {
    /* приватный режим — сессия проживёт только в памяти вкладки */
  }
  memoryToken = token;
}

let memoryToken: string | null = null;

export function clearStaffSession(): void {
  memoryToken = null;
  try { sessionStorage.removeItem(KEY); } catch { /* нечего чистить */ }
}

/** Ошибка staff API с машинным кодом (need_confirm и т.п.). */
export class StaffError extends ApiError {
  code?: string;
  detail?: Record<string, unknown>;
}

async function staffApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = staffToken() ?? memoryToken;
  const res = await fetch(`/api/staff${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers as Record<string, string>),
    },
  });
  if (res.status === 401 || res.status === 403) clearStaffSession();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new StaffError(errorText(body, res.status), res.status);
    const detail = (body as { detail?: unknown }).detail;
    if (detail && typeof detail === "object") {
      err.detail = detail as Record<string, unknown>;
      err.code = (detail as { code?: string }).code;
    }
    throw err;
  }
  return res.json();
}

// ------------------------------------------------------------------ вход ----
export function fetchEligible(): Promise<{ eligible: boolean }> {
  return api("/staff/eligible");
}

export function startStaffLogin(): Promise<{ request_id: string; sent: boolean; ttl_seconds: number }> {
  return api("/staff/login", { method: "POST" });
}

export type LoginPoll = { status: "pending" | "expired" } | { status: "approved"; token: string; expires_in: number };

export function pollStaffLogin(requestId: string): Promise<LoginPoll> {
  return api(`/staff/login/${encodeURIComponent(requestId)}`);
}

// ---------------------------------------------------------------- товары ----
export type StaffProduct = {
  id: number;
  sku: string | null;
  title: string;
  brand: string | null;
  category: string | null;
  price: number | null;
  in_stock: boolean;
  is_active: boolean;
  image: string | null;
  price_changed_at: string | null;
};

export type StaffFilter = "all" | "in_stock" | "out_of_stock" | "recent";

export type PriceChange = {
  id: number;
  old_price: number | null;
  new_price: number;
  source: string;
  actor: string;
  note: string | null;
  created_at: string | null;
};

export function listStaffProducts(q: string, filter: StaffFilter, offset = 0):
  Promise<{ total: number; items: StaffProduct[] }> {
  const params = new URLSearchParams({ q, filter, offset: String(offset), limit: "50" });
  return staffApi(`/products?${params}`);
}

export function patchStaffProduct(id: number, body: { price?: number; in_stock?: boolean; confirm?: boolean }):
  Promise<StaffProduct> {
  return staffApi(`/products/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function staffHistory(id: number): Promise<{ items: PriceChange[] }> {
  return staffApi(`/products/${id}/history`);
}

export function revertPrice(id: number, changeId: number): Promise<StaffProduct> {
  return staffApi(`/products/${id}/revert/${changeId}`, { method: "POST" });
}

// ----------------------------------------------------------- чистые хелперы ----
/** «132 500», «132500», «132.500», «132 500 ₽» -> 132500. Мусор -> null. */
export function parsePriceInput(raw: string): number | null {
  const digits = raw.replace(/[\s.,₽]/g, "");
  if (!/^\d{1,9}$/.test(digits)) return null;
  const n = Number(digits);
  return n >= 1 ? n : null;
}

/** Доля изменения, после которой сервер просит «точно?» (api/staff.py BIG_CHANGE). */
export const BIG_CHANGE = 0.3;

export function isBigChange(oldPrice: number | null, newPrice: number): boolean {
  if (!oldPrice) return false;
  return Math.abs(newPrice - oldPrice) / oldPrice > BIG_CHANGE;
}

const SOURCE_LABEL: Record<string, string> = {
  staff: "вручную", admin_site: "админка", import: "импорт", bsa: "BSA",
  apostl: "apostl", script: "скрипт", unknown: "система",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}
