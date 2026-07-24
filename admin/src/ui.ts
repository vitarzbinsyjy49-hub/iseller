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

/** Мультизагрузка файлов (v5.4.0): поле "files" повторяется. Возвращает товар +
 *  _upload (added/rejected/count/limit) для отчёта о частичном результате. */
export async function apiUploadMany<T>(path: string, token: string, files: File[]): Promise<T> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
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

export const MAX_PRODUCT_IMAGES = 10;

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

// v5.4.0: сценарные типы заявок
export const LEAD_TYPES = ["general", "product", "trade_in", "b2b", "wholesale"];
export const LEAD_TYPE_RU: Record<string, string> = {
  general: "Обычная", product: "Товар", trade_in: "Trade-In", b2b: "Для бизнеса", wholesale: "Опт",
};

const META_VALUE_RU: Record<string, Record<string, string>> = {
  device_type: { iphone: "iPhone", macbook: "MacBook", ipad: "iPad", apple_watch: "Apple Watch", other: "Другое" },
  condition: { excellent: "Отличное", normal: "Нормальное", damaged: "Есть повреждения", dead: "Не включается" },
  intent: { exchange: "Обмен на другое", sell: "Продажа" },
  equipment: {
    smartphones: "Смартфоны", laptops: "Ноутбуки", tablets: "Планшеты",
    staff_devices: "Техника для сотрудников", complex: "Комплексная поставка", other: "Другое",
  },
  category: {
    iphone: "iPhone", macbook: "MacBook", other_tech: "Другая техника",
    accessories: "Аксессуары", mixed: "Смешанная партия",
  },
};
const META_KEY_RU: Record<string, string> = {
  device_type: "Устройство", model: "Модель", memory: "Память", condition: "Состояние",
  intent: "Цель", desired_device: "Хочет получить", equipment: "Оборудование",
  quantity_range: "Количество", company: "Компания", city: "Город",
  category: "Категория", budget: "Бюджет",
};
const META_HIDDEN = new Set(["origin"]);

/** Локализованные строки metadata заявки (без origin/пустых). Неизвестные ключи
 *  показываем нейтрально — как есть. Никакого сырого JSON в UI. */
export function leadMetaRows(metadata?: Record<string, unknown> | null): { label: string; value: string }[] {
  if (!metadata || typeof metadata !== "object") return [];
  const rows: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (META_HIDDEN.has(key) || seen.has(key)) return;
    const raw = (metadata as Record<string, unknown>)[key];
    if (raw == null) return;
    const value = Array.isArray(raw) ? raw.map(String).join(", ") : String(raw);
    if (!value.trim()) return;
    seen.add(key);
    rows.push({ label: META_KEY_RU[key] ?? key, value: META_VALUE_RU[key]?.[value] ?? value });
  };
  for (const key of Object.keys(META_KEY_RU)) if (key in metadata) push(key);
  for (const key of Object.keys(metadata)) push(key);
  return rows;
}
