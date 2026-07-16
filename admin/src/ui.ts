/** Общие стили (светлая тема Telegram × Яндекс) и API-хелперы админки. */
import type { CSSProperties } from "react";

export const C = {
  bg: "#f6f7f9", surface: "#ffffff", muted: "#f1f3f5", border: "#e8eaee",
  text: "#111827", sub: "#6b7280", accent: "#2aabee", accentDark: "#229ed9",
  green: "#35c759", yellow: "#ff9f0a", red: "#ff3b30",
};

export const card: CSSProperties = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20,
  boxShadow: "0 1px 3px rgba(17,24,39,.04)",
};

export const input: CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10,
  border: `1px solid ${C.border}`, background: C.muted, color: C.text, marginTop: 6, outline: "none",
};

export const btn: CSSProperties = {
  padding: "10px 14px", borderRadius: 10, border: "none",
  background: C.accent, color: "#fff", fontWeight: 600, cursor: "pointer",
};

export const btnGhost: CSSProperties = {
  ...btn, background: C.muted, color: C.text,
};

export const chip = (active: boolean): CSSProperties => ({
  padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontSize: 13, fontWeight: 500,
  border: `1px solid ${active ? C.accent : C.border}`,
  background: active ? C.accent : C.surface, color: active ? "#fff" : C.sub,
});

export async function apiGet<T>(path: string, token: string): Promise<T> {
  const r = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function apiSend<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

export const apiPatch = <T,>(path: string, token: string, body: unknown) => apiSend<T>("PATCH", path, token, body);
export const apiPost = <T,>(path: string, token: string, body: unknown) => apiSend<T>("POST", path, token, body);

/** Загрузка файла (multipart). Content-Type НЕ ставим — браузер сам выставит boundary. */
export async function apiUpload<T>(path: string, token: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

export function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("ru-RU").format(Math.round(v)) + " ₽";
}

export const STATUS_RU: Record<string, string> = {
  new: "Новая", in_progress: "В работе", reserved: "Бронь", completed: "Завершена", cancelled: "Отменена",
};
export const STATUSES = ["new", "in_progress", "reserved", "completed", "cancelled"];
export const SOURCE_RU: Record<string, string> = {
  ai: "AI", product: "Товар", catalog: "Каталог", home: "Главная", manager: "Менеджер", other: "Другое",
};
